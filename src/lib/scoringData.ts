// src/lib/scoringData.ts
//
// Assembles per-platform inputs for the Influence Rating engine and
// orchestrates a calculate-and-store pass for one creator. Called both
// on-connect and from the background recalculation worker.

import { supabase } from "./supabase";
import { getIGMedia } from "./instagram";
import {
  audienceScore,
  engagementScore,
  impactScore,
  combinePlatformScores,
  finalRating,
  confidenceScore,
  type PlatformPillarScores,
} from "./influenceScore";

interface PlatformScoringInput extends PlatformPillarScores {
  postsConsidered: number;
}

async function getTikTokScoringInput(userId: string): Promise<PlatformScoringInput | null> {
  const { data: account } = await supabase
    .from("social_accounts")
    .select("follower_count")
    .eq("user_id", userId)
    .eq("platform", "tiktok")
    .single();

  if (!account) return null;

  const { data: posts } = await supabase
    .from("tiktok_posts")
    .select("like_count, comment_count, share_count, view_count, engagement_rate")
    .eq("user_id", userId);

  const rows = posts ?? [];
  const postsConsidered = rows.length;

  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0);
  const avg = (total: number) => (postsConsidered > 0 ? total / postsConsidered : 0);

  const totalLikes    = sum((r) => r.like_count);
  const totalComments = sum((r) => r.comment_count);
  const totalShares   = sum((r) => r.share_count);
  const totalViews    = sum((r) => r.view_count);
  const avgEngagementRate = postsConsidered > 0 ? avg(sum((r) => r.engagement_rate)) : 0;

  const followers = account.follower_count ?? 0;

  return {
    followers,
    audience: audienceScore(followers),
    engagement: engagementScore({
      engagementRatePct: avgEngagementRate,
      avgLikes: avg(totalLikes),
      avgComments: avg(totalComments),
      avgShares: avg(totalShares),
    }),
    impact: impactScore({ totalLikes, totalViews, totalComments, totalShares }),
    postsConsidered,
  };
}

// Instagram's API doesn't expose per-post shares or views, so those stay
// null (not 0) all the way through the scoring math.
async function getInstagramScoringInput(userId: string): Promise<PlatformScoringInput | null> {
  const { data: account } = await supabase
    .from("social_accounts")
    .select("follower_count, platform_user_id, access_token")
    .eq("user_id", userId)
    .eq("platform", "instagram")
    .single();

  if (!account) return null;

  let media: Awaited<ReturnType<typeof getIGMedia>> = [];
  try {
    media = await getIGMedia(account.platform_user_id, account.access_token);
  } catch (err: any) {
    console.warn(`Influence score: failed to fetch Instagram media for user ${userId}:`, err.message);
  }

  const postsConsidered = media.length;
  const totalLikes    = media.reduce((s, m) => s + (Number(m.like_count) || 0), 0);
  const totalComments = media.reduce((s, m) => s + (Number(m.comments_count) || 0), 0);
  const followers      = account.follower_count ?? 0;
  const avgLikes        = postsConsidered > 0 ? totalLikes / postsConsidered : 0;
  const avgComments     = postsConsidered > 0 ? totalComments / postsConsidered : 0;
  const engagementRatePct = followers > 0 ? ((avgLikes + avgComments) / followers) * 100 : 0;

  return {
    followers,
    audience: audienceScore(followers),
    engagement: engagementScore({ engagementRatePct, avgLikes, avgComments, avgShares: null }),
    impact: impactScore({ totalLikes, totalViews: null, totalComments, totalShares: null }),
    postsConsidered,
  };
}

export async function calculateAndStoreInfluenceScore(creatorId: string): Promise<void> {
  const [tiktok, instagram] = await Promise.all([
    getTikTokScoringInput(creatorId),
    getInstagramScoringInput(creatorId),
  ]);

  const platforms = [tiktok, instagram].filter((p): p is PlatformScoringInput => p !== null);
  if (platforms.length === 0) return;

  const combined = combinePlatformScores(platforms);
  const rating = finalRating(combined.audience, combined.engagement, combined.impact);
  const totalPosts = platforms.reduce((s, p) => s + p.postsConsidered, 0);
  const confidence = confidenceScore(totalPosts);

  const platformBreakdown: Record<string, unknown> = {};
  if (tiktok)    platformBreakdown.tiktok    = { followers: tiktok.followers, audience: tiktok.audience, engagement: tiktok.engagement, impact: tiktok.impact };
  if (instagram) platformBreakdown.instagram = { followers: instagram.followers, audience: instagram.audience, engagement: instagram.engagement, impact: instagram.impact };

  const { data: existing } = await supabase
    .from("creator_influence_scores")
    .select("score, previous_score, score_change_24h, calculated_at")
    .eq("creator_id", creatorId)
    .single();

  const now = new Date();
  let previousScore = existing?.previous_score ?? null;
  let scoreChange24h = existing?.score_change_24h ?? null;

  if (existing) {
    const staleSince24h = new Date(existing.calculated_at).getTime() < now.getTime() - 24 * 60 * 60 * 1000;
    if (staleSince24h) {
      previousScore = existing.score;
      scoreChange24h = existing.score > 0 ? ((rating - existing.score) / existing.score) * 100 : 0;
    }
  }

  const { error: upsertError } = await supabase
    .from("creator_influence_scores")
    .upsert(
      {
        creator_id: creatorId,
        score: rating,
        audience_score: combined.audience,
        engagement_score: combined.engagement,
        impact_score: combined.impact,
        previous_score: previousScore,
        score_change_24h: scoreChange24h,
        confidence_score: confidence,
        platform_breakdown: platformBreakdown,
        calculated_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: "creator_id" }
    );

  if (upsertError) {
    console.error(`Influence score: failed to upsert for creator ${creatorId}:`, upsertError.message);
    return;
  }

  const [{ count: countLessEq }, { count: totalCount }] = await Promise.all([
    supabase.from("creator_influence_scores").select("id", { count: "exact", head: true }).lte("score", rating),
    supabase.from("creator_influence_scores").select("id", { count: "exact", head: true }),
  ]);

  const percentile = totalCount && totalCount > 0 ? Math.round(((countLessEq ?? 0) / totalCount) * 100) : 100;

  await supabase
    .from("creator_influence_scores")
    .update({ percentile })
    .eq("creator_id", creatorId);
}
