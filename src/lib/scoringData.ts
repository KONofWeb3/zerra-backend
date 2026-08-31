// src/lib/scoringData.ts
//
// Assembles the raw per-platform inputs the Influence Rating engine needs,
// then orchestrates a full calculate-and-store pass for one creator.
// This is the single entry point called both on-connect (immediate,
// non-zero rating) and from the background recalculation worker.

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

// ── TikTok ───────────────────────────────────────────────────────────────
// Reads only already-persisted data (social_accounts + tiktok_posts) — no
// live API call, no risk of hitting TikTok's rate limits from a background job.
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

// ── Instagram ────────────────────────────────────────────────────────────
// Follower count is already persisted (from connect), but post-level
// engagement isn't stored anywhere yet — pull it live via the existing
// getIGMedia() call (≤25 posts, cheap). Instagram's API doesn't expose
// per-post shares or views at all, so those stay null throughout, not 0.
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
    // Expired/revoked token, rate limit, etc. — don't let one bad platform
    // crash the whole score calc; just score off what we already have.
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
    engagement: engagementScore({
      engagementRatePct,
      avgLikes,
      avgComments,
      avgShares: null, // Instagram Graph API doesn't expose shares
    }),
    impact: impactScore({ totalLikes, totalViews: null, totalComments, totalShares: null }),
    postsConsidered,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────
export async function calculateAndStoreInfluenceScore(creatorId: string): Promise<void> {
  const [tiktok, instagram] = await Promise.all([
    getTikTokScoringInput(creatorId),
    getInstagramScoringInput(creatorId),
  ]);

  const platforms = [tiktok, instagram].filter((p): p is PlatformScoringInput => p !== null);

  if (platforms.length === 0) {
    // No connected account with usable data — nothing honest to score yet.
    // Never write a fabricated 0; just skip (the /me/influence-rating route
    // returns { calculated: false } until a real row exists).
    return;
  }

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
      // Only shift the 24h snapshot forward once a day — otherwise a job
      // that ticks every few hours would keep comparing against itself
      // and the "24h change" would never mean what it says.
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

  // Percentile — cheap at current scale; revisit if the creator table grows large.
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
