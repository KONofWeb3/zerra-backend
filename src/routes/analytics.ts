import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import { getTikTokVideos } from "../lib/tiktok";
import { inngest } from "../inngest/client";

const router = Router();

// POST /analytics/tiktok/sync — fetch latest posts, save immediately, fire AI verification jobs
router.post("/tiktok/sync", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data: account, error: accountError } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("user_id", user.id)
    .eq("platform", "tiktok")
    .single();

  if (accountError || !account) {
    res.status(404).json({ error: "No TikTok account connected" });
    return;
  }

  if (new Date(account.expires_at) < new Date()) {
    res.status(401).json({ error: "TikTok token expired, please reconnect" });
    return;
  }

  try {
    const videos = await getTikTokVideos(account.access_token);

    if (!videos || videos.length === 0) {
      res.json({ message: "No videos found", synced: 0 });
      return;
    }

    type TikTokVideo = Awaited<ReturnType<typeof getTikTokVideos>>[number];
    const rows = videos.map((v: TikTokVideo) => {
      const totalEngagements = v.like_count + v.comment_count + v.share_count;
      const engagementRate =
        v.view_count > 0
          ? parseFloat(((totalEngagements / v.view_count) * 100).toFixed(2))
          : 0;

      return {
        user_id: user.id,
        post_id: v.id,
        title: v.title,
        cover_image_url: v.cover_image_url,
        view_count: v.view_count,
        like_count: v.like_count,
        comment_count: v.comment_count,
        share_count: v.share_count,
        engagement_rate: engagementRate,
        fetched_at: new Date().toISOString(),
      };
    });

    // Save videos to dashboard immediately — creator sees them right away
    const { error: upsertError } = await supabase
      .from("tiktok_posts")
      .upsert(rows, { onConflict: "user_id,post_id" });

    if (upsertError) {
      res.status(500).json({ error: upsertError.message });
      return;
    }

    // Fire background AI verification job for each video
    // (Currently fires for ALL synced videos — add a campaign-tag filter here
    //  once campaign tagging exists, matching the spec's `isCampaignTagged` check)
    await Promise.all(
      videos.map((v: TikTokVideo) =>
        inngest.send({
          name: "video/synced",
          data: {
            videoId: v.id,
            creatorId: user.id,
            campaignId: null, // wire up once campaign association exists
            videoUrl: v.embed_link,
            caption: v.video_description || v.title || "",
            creatorHandle: account.username ?? "unknown",
            campaignName: "General", // placeholder until campaign tagging exists
            likes: v.like_count,
            views: v.view_count,
            comments: v.comment_count,
            shares: v.share_count,
          },
        })
      )
    );

    res.json({ message: "Synced successfully", synced: rows.length, verifying: videos.length });
  } catch (err: any) {
    console.error("TikTok sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /analytics/tiktok — get stored analytics for logged in user, now includes verification data
router.get("/tiktok", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data: posts, error } = await supabase
    .from("tiktok_posts")
    .select("*")
    .eq("user_id", user.id)
    .order("view_count", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (!posts || posts.length === 0) {
    res.json({ analytics: null, message: "No data yet, sync first" });
    return;
  }

  // Fetch verification results for these posts
  const postIds = posts.map((p) => p.post_id);
  const { data: analyses } = await supabase
    .from("video_analysis")
    .select("*")
    .in("video_id", postIds);

  const analysisMap = new Map((analyses ?? []).map((a) => [a.video_id, a]));

  const postsWithAnalysis = posts.map((p) => ({
    ...p,
    verification: analysisMap.get(p.post_id) ?? null,
  }));

  const totalViews = posts.reduce((sum, p) => sum + Number(p.view_count), 0);
  const totalLikes = posts.reduce((sum, p) => sum + Number(p.like_count), 0);
  const totalComments = posts.reduce((sum, p) => sum + Number(p.comment_count), 0);
  const totalShares = posts.reduce((sum, p) => sum + Number(p.share_count), 0);
  const avgEngagementRate = parseFloat(
    (posts.reduce((sum, p) => sum + Number(p.engagement_rate), 0) / posts.length).toFixed(2)
  );

  res.json({
    analytics: {
      summary: {
        total_posts: posts.length,
        total_views: totalViews,
        total_likes: totalLikes,
        total_comments: totalComments,
        total_shares: totalShares,
        avg_engagement_rate: avgEngagementRate,
      },
      posts: postsWithAnalysis,
    },
  });
});

// GET /analytics/top-creators — ranked list, now sorted by verified final_score where available
router.get("/top-creators", async (_req, res: Response) => {
  const { data, error } = await supabase
    .from("tiktok_posts")
    .select(`
      user_id,
      users ( name, avatar ),
      social_accounts!inner ( username, platform )
    `)
    .eq("social_accounts.platform", "tiktok");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const creatorMap = new Map<string, any>();

  for (const row of data as any[]) {
    const uid = row.user_id;
    if (!creatorMap.has(uid)) {
      creatorMap.set(uid, {
        user_id: uid,
        name: row.users?.name,
        avatar: row.users?.avatar,
        username: row.social_accounts?.username,
        total_views: 0,
        total_likes: 0,
        total_comments: 0,
        total_shares: 0,
        post_count: 0,
        engagement_rates: [] as number[],
      });
    }

    const creator = creatorMap.get(uid);
    creator.total_views += Number(row.view_count || 0);
    creator.total_likes += Number(row.like_count || 0);
    creator.total_comments += Number(row.comment_count || 0);
    creator.total_shares += Number(row.share_count || 0);
    creator.post_count += 1;
    creator.engagement_rates.push(Number(row.engagement_rate || 0));
  }

  // Pull leaderboard totals (AI-verified scores) for these creators
  const userIds = Array.from(creatorMap.keys());
  const { data: leaderboardRows } = await supabase
    .from("leaderboard")
    .select("creator_id, total_score")
    .in("creator_id", userIds)
    .is("campaign_id", null); // global leaderboard entries

  const scoreMap = new Map((leaderboardRows ?? []).map((r) => [r.creator_id, r.total_score]));

  const creators = Array.from(creatorMap.values())
    .map((c) => ({
      ...c,
      avg_engagement_rate: parseFloat(
        (c.engagement_rates.reduce((s: number, r: number) => s + r, 0) / c.engagement_rates.length).toFixed(2)
      ),
      verified_score: scoreMap.get(c.user_id) ?? 0,
      engagement_rates: undefined,
    }))
    // Sort by verified_score first (AI-verified leaderboard), fall back to engagement rate
    // for creators who haven't completed verification yet
    .sort((a, b) => {
      if (b.verified_score !== a.verified_score) return b.verified_score - a.verified_score;
      return b.avg_engagement_rate - a.avg_engagement_rate;
    });

  res.json({ creators });
});

export default router;