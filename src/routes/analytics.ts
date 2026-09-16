import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import { syncTikTokPosts } from "../lib/syncTikTok";
import { getClassifiedPosts, computePerformanceInsight, computeInfluenceFit, computeBestTimeWindow } from "../lib/analyticsInsights";

const router = Router();

// POST /analytics/tiktok/sync — fetch videos, save all to dashboard,
// but only queue AI verification for videos matching an active campaign.
router.post("/tiktok/sync", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const result = await syncTikTokPosts(user.id);

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({ message: result.message, synced: result.synced, campaignMatches: result.campaignMatches });
});

// GET /analytics/tiktok/campaign-matched — ONLY videos that matched at least one
// active campaign's hashtags. This is what the Top Performing page should call —
// it shows campaign performance, not the creator's full TikTok history.
router.get("/tiktok/campaign-matched", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  // Get all video_analysis rows for this creator — these only exist for videos
  // that passed the campaign hashtag match and got queued for AI verification
  const { data: analyses, error } = await supabase
    .from("video_analysis")
    .select(`
      *,
      tiktok_posts:video_id ( title, cover_image_url, view_count, like_count, comment_count, share_count, engagement_rate, fetched_at ),
      bounties:campaign_id ( project_name, token_icon, required_hashtags )
    `)
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (!analyses || analyses.length === 0) {
    res.json({
      posts: [],
      message: "No campaign-matched posts yet. Join a campaign and post with its required hashtag, then sync your TikTok.",
    });
    return;
  }

  res.json({ posts: analyses });
});

// GET /analytics/tiktok — stored analytics + verification data for the logged-in user
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

// GET /analytics/tiktok/insights — Performance list + Zerra Insight +
// Where Your Influence Fit cards. See lib/analyticsInsights.ts.
router.get("/tiktok/insights", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const posts = await getClassifiedPosts(user.id);

  if (posts.length === 0) {
    res.json({
      bestPlatform: null,
      bestFormat: null,
      bestTime: null,
      performanceInsight: null,
      influenceFit: null,
    });
    return;
  }

  const [performanceInsight, influenceFit] = await Promise.all([
    Promise.resolve(computePerformanceInsight(posts)),
    computeInfluenceFit(posts),
  ]);

  res.json({
    bestPlatform: "TikTok",
    bestFormat: "Video",
    bestTime: computeBestTimeWindow(posts),
    performanceInsight,
    influenceFit,
  });
});

// GET /analytics/top-creators — ranked list, now sorted by verified final_score where available
router.get("/top-creators", async (_req, res: Response) => {
  // This previously embedded social_accounts directly off tiktok_posts. There
  // is no FK between those two tables (both point at users), so PostgREST
  // rejected the entire request with "Could not find a relationship ... in the
  // schema cache" and the endpoint always 500'd. It also never selected the
  // metric columns it then summed, so every total would have been 0 even if
  // the join had worked. Handles are now fetched separately and merged.
  const { data, error } = await supabase
    .from("tiktok_posts")
    .select(`
      user_id,
      view_count,
      like_count,
      comment_count,
      share_count,
      engagement_rate,
      users ( name, avatar )
    `);

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
        name: row.users?.name ?? null,
        avatar: row.users?.avatar ?? null,
        username: null as string | null,
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

  const userIds = Array.from(creatorMap.keys());

  // TikTok handles, fetched separately since there's no direct FK to join on
  const { data: handleRows } = await supabase
    .from("social_accounts")
    .select("user_id, username")
    .eq("platform", "tiktok")
    .in("user_id", userIds);

  for (const row of handleRows ?? []) {
    const creator = creatorMap.get(row.user_id);
    if (creator) creator.username = row.username ?? null;
  }

  // Pull leaderboard totals (AI-verified scores) for these creators
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
    // Sort by actual reach (total_views) first - that's what "Top Creators" means
    // to anyone looking at this list. verified_score defaults to 0 for anyone who
    // hasn't completed an AI-verified campaign yet, so sorting on it primarily was
    // ranking small test accounts above creators with tens of millions of real
    // followers just because they'd never run a verified campaign. Score and
    // engagement rate are still shown as their own columns, just not the primary
    // rank driver.
    .sort((a, b) => {
      if (b.total_views !== a.total_views) return b.total_views - a.total_views;
      if (b.verified_score !== a.verified_score) return b.verified_score - a.verified_score;
      return b.avg_engagement_rate - a.avg_engagement_rate;
    });

  res.json({ creators });
});

// GET /analytics/campaigns/:campaignId/my-posts — creator's verified posts for ONE campaign
router.get("/campaigns/:campaignId/my-posts", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { campaignId } = req.params;

  const { data: analyses, error } = await supabase
    .from("video_analysis")
    .select(`
      *,
      tiktok_posts:video_id ( title, cover_image_url, view_count, like_count, comment_count, share_count )
    `)
    .eq("creator_id", user.id)
    .eq("campaign_id", campaignId)
    .order("final_score", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  if (!analyses || analyses.length === 0) {
    res.json({
      posts: [],
      message: "You don't have any posts related to this campaign yet. Post content with the required hashtag or keyword, then sync your TikTok again.",
    });
    return;
  }

  res.json({ posts: analyses });
});

export default router;