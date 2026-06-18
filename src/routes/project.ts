// src/routes/project.ts
import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireProject } from "../middleware/requireRole";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

const router = Router();
router.use(requireAuth, requireProject);

// Helper — get the project_id tied to the logged-in project account
async function getProjectId(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("projects")
    .select("id")
    .eq("user_id", userId)
    .single();
  return data?.id ?? null;
}

// GET /project/overview — campaign summary + key metrics
router.get("/overview", async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = await getProjectId(user.id);
  if (!projectId) { res.status(404).json({ error: "No project found for this account" }); return; }

  const { data: campaigns } = await supabase
    .from("bounties")
    .select("*")
    .eq("project_id", projectId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false });

  if (!campaigns?.length) {
    res.json({ campaigns: [], metrics: null });
    return;
  }

  const campaignIds = campaigns.map((c) => c.id);

  // Pull all video_analysis rows for these campaigns
  const { data: analyses } = await supabase
    .from("video_analysis")
    .select("*")
    .in("campaign_id", campaignIds);

  const rows = analyses ?? [];
  const completed   = rows.filter((r) => r.status === "completed");
  const eligible    = rows.filter((r) => r.leaderboard_eligible);
  const quarantined = rows.filter((r) => r.status === "quarantined");

  const avgAuthenticity = completed.length
    ? Math.round(completed.reduce((s, r) => s + (r.authenticity_score ?? 0), 0) / completed.length)
    : 0;

  const avgFinalScore = eligible.length
    ? Math.round(eligible.reduce((s, r) => s + (r.final_score ?? 0), 0) / eligible.length)
    : 0;

  // Unique participants across all campaigns
  const uniqueCreators = new Set(rows.map((r) => r.creator_id)).size;

  res.json({
    campaigns,
    metrics: {
      totalCampaigns:    campaigns.length,
      activeCampaigns:   campaigns.filter((c) => c.status === "active").length,
      totalParticipants: uniqueCreators,
      totalVideosAnalyzed: completed.length,
      eligibleVideos:    eligible.length,
      quarantinedVideos: quarantined.length,
      avgAuthenticityScore: avgAuthenticity,
      avgFinalScore,
      verificationPassRate: completed.length
        ? Math.round((eligible.length / completed.length) * 100)
        : 0,
    },
  });
});

// GET /project/leaderboard?campaignId=xxx — ranked creators for a specific campaign
router.get("/leaderboard", async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { campaignId } = req.query;

  const projectId = await getProjectId(user.id);
  if (!projectId) { res.status(404).json({ error: "No project found" }); return; }

  // Confirm campaign belongs to this project
  const { data: campaign } = await supabase
    .from("bounties")
    .select("id, project_name, reward_usdc, total_budget_usdc, spent_usdc")
    .eq("id", campaignId as string)
    .eq("project_id", projectId)
    .single();

  if (!campaign) { res.status(403).json({ error: "Campaign not found or not yours" }); return; }

  const { data: leaderboard } = await supabase
    .from("leaderboard")
    .select(`
      *,
      users:creator_id ( name, avatar, email ),
      social_accounts ( username )
    `)
    .eq("campaign_id", campaignId as string)
    .order("total_score", { ascending: false })
    .limit(50);

  res.json({ campaign, leaderboard: leaderboard ?? [] });
});

// GET /project/videos?campaignId=xxx — verified videos with full scores for a campaign
router.get("/videos", async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { campaignId } = req.query;

  const projectId = await getProjectId(user.id);
  if (!projectId) { res.status(404).json({ error: "No project found" }); return; }

  const { data: campaign } = await supabase
    .from("bounties")
    .select("id")
    .eq("id", campaignId as string)
    .eq("project_id", projectId)
    .single();

  if (!campaign) { res.status(403).json({ error: "Campaign not found or not yours" }); return; }

  const { data: videos } = await supabase
    .from("video_analysis")
    .select(`
      *,
      tiktok_posts:video_id ( title, cover_image_url, view_count, like_count, comment_count, share_count ),
      users:creator_id ( name, avatar )
    `)
    .eq("campaign_id", campaignId as string)
    .order("final_score", { ascending: false });

  res.json({ videos: videos ?? [] });
});

// GET /project/participants?campaignId=xxx — participant count + joined_at timeline
router.get("/participants", async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { campaignId } = req.query;

  const projectId = await getProjectId(user.id);
  if (!projectId) { res.status(404).json({ error: "No project found" }); return; }

  const { data: campaign } = await supabase
    .from("bounties")
    .select("id")
    .eq("id", campaignId as string)
    .eq("project_id", projectId)
    .single();

  if (!campaign) { res.status(403).json({ error: "Campaign not found or not yours" }); return; }

  const { data: claims } = await supabase
    .from("claims")
    .select(`
      created_at,
      users:user_id ( name, avatar, email ),
      social_accounts ( username )
    `)
    .eq("bounty_id", campaignId as string)
    .order("created_at", { ascending: false });

  res.json({ participants: claims ?? [], total: claims?.length ?? 0 });
});

export default router;