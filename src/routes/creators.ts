// src/routes/creators.ts
//
// Creator Profile page data — requireAuth only (not truly public yet, since
// there's no public-facing shell around the authenticated app), but usable
// by any logged-in user to view any creator's profile by username.

import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { supabase } from "../lib/supabase";

const router = Router();

// GET /creators/:username
router.get("/:username", requireAuth, async (req, res: Response) => {
  const username = String(req.params.username);

  const { data: creator, error: creatorError } = await supabase
    .from("users")
    .select("id, name, username, avatar, bio, location, niche")
    .eq("username", username.toLowerCase())
    .single();

  if (creatorError || !creator) {
    res.status(404).json({ error: "Creator not found" });
    return;
  }

  const [socialAccountsRes, scorecardRes, postsRes, claimsRes, earningsRes] = await Promise.all([
    supabase.from("social_accounts").select("platform, username, follower_count").eq("user_id", creator.id),
    supabase.from("creator_scorecards").select("*").eq("creator_id", creator.id).single(),
    supabase.from("tiktok_posts").select("post_id, title, cover_image_url, view_count, like_count, engagement_rate, fetched_at")
      .eq("user_id", creator.id).order("view_count", { ascending: false }).limit(10),
    supabase.from("claims").select("id, status").eq("user_id", creator.id),
    supabase.from("earnings").select("amount_usdc").eq("user_id", creator.id),
  ]);

  const socialAccounts = socialAccountsRes.data ?? [];
  const posts = postsRes.data ?? [];
  const claims = claimsRes.data ?? [];
  const totalEarned = (earningsRes.data ?? []).reduce((s, e) => s + Number(e.amount_usdc || 0), 0);

  // Creator Highlights — derived from real data only; "Best Performing Niche"
  // from the reference screenshot doesn't map to anything real (niche is a
  // creator-level field, not per-post) so it's left out rather than guessed.
  const mostEngagingContent = posts.length > 0
    ? [...posts].sort((a, b) => Number(b.engagement_rate) - Number(a.engagement_rate))[0]
    : null;

  const topPerformingPlatform = socialAccounts.length > 0
    ? [...socialAccounts].sort((a, b) => (b.follower_count ?? 0) - (a.follower_count ?? 0))[0].platform
    : null;

  res.json({
    creator,
    socialAccounts,
    scorecard: scorecardRes.data ?? null, // null → frontend shows "not enough data yet", never a fake score
    recentContent: posts.slice(0, 5),
    highlights: {
      mostEngagingContent: mostEngagingContent
        ? { title: mostEngagingContent.title, engagementRate: mostEngagingContent.engagement_rate }
        : null,
      topPerformingPlatform,
      recentCampaigns: { count: claims.length, totalEarnedUsdc: totalEarned },
    },
  });
});

export default router;
