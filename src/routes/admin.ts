// src/routes/admin.ts
import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/requireRole";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import crypto from "crypto";

const router = Router();
router.use(requireAuth, requireAdmin);

function generateTempPassword(): string {
  // 12-char random password, URL-safe
  return crypto.randomBytes(9).toString("base64").replace(/[/+=]/g, "").slice(0, 12);
}

async function logAdminAction(
  adminId: string,
  actionType: string,
  targetType: string,
  targetId: string,
  reason?: string,
  metadata?: object
) {
  await supabase.from("admin_actions").insert({
    admin_id: adminId,
    action_type: actionType,
    target_type: targetType,
    target_id: targetId,
    reason,
    metadata,
  });
}

// ─────────────────────────────────────────────
// CAMPAIGN CREATION — auto-generates project login
// ─────────────────────────────────────────────

// POST /admin/campaigns — create a new campaign + auto-generate project account if new
router.post("/campaigns", async (req, res: Response) => {
  const admin = (req as unknown as AuthRequest).user;
  const {
    projectName,
    projectContactEmail,
    projectLogoUrl,
    existingProjectId,    // if set, reuse an existing project instead of creating new
    campaignTitle,
    description,
    requiredHashtags,     // string[]
    requiredKeywords,     // string[]
    rewardUsdc,
    totalBudgetUsdc,
    startsAt,
    endsAt,
    coverImageUrl,
    tokenIconUrl,
  } = req.body;

  if (!campaignTitle || !requiredHashtags?.length) {
    res.status(400).json({ error: "Campaign title and at least one required hashtag are needed" });
    return;
  }

  try {
    let projectId = existingProjectId;
    let generatedCredentials: { email: string; tempPassword: string } | null = null;

    // Create a new project + auto-generated login if one wasn't specified
    if (!projectId) {
      if (!projectName || !projectContactEmail) {
        res.status(400).json({ error: "Project name and contact email are required for a new project" });
        return;
      }

      const tempPassword = generateTempPassword();

      // Create the Supabase auth user for this project
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email: projectContactEmail,
        password: tempPassword,
        email_confirm: true, // skip email confirmation for admin-created accounts
      });

      if (authError || !authUser.user) {
        res.status(500).json({ error: authError?.message ?? "Failed to create project account" });
        return;
      }

      // Upsert the users row with role = 'project'.
      // Using upsert (not update) because Supabase's auth trigger that creates the
      // users row may not have fired yet at this point — upsert ensures it exists
      // regardless of trigger timing.
      await supabase
        .from("users")
        .upsert(
          { id: authUser.user.id, email: projectContactEmail, name: projectName, role: "project" },
          { onConflict: "id" }
        );

      // Create the project record
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({
          name: projectName,
          logo_url: projectLogoUrl ?? null,
          contact_email: projectContactEmail,
          user_id: authUser.user.id,
          created_by: admin.id,
        })
        .select()
        .single();

      if (projectError || !project) {
        res.status(500).json({ error: projectError?.message ?? "Failed to create project" });
        return;
      }

      projectId = project.id;
      generatedCredentials = { email: projectContactEmail, tempPassword };

      await logAdminAction(admin.id, "create_project", "project", projectId, undefined, {
        projectName,
      });
    }

    // Create the campaign (bounty)
    const { data: campaign, error: campaignError } = await supabase
      .from("bounties")
      .insert({
        project_id: projectId,
        project_name: projectName,
        description,
        required_hashtags: requiredHashtags,
        required_keywords: requiredKeywords ?? [],
        reward_usdc: rewardUsdc,
        total_budget_usdc: totalBudgetUsdc,
        starts_at: startsAt ?? null,
        ends_at: endsAt ?? null,
        status: "draft",
        created_by: admin.id,
        cover_image_url: coverImageUrl ?? null,
        token_icon: tokenIconUrl ?? null,
      })
      .select()
      .single();

    if (campaignError || !campaign) {
      res.status(500).json({ error: campaignError?.message ?? "Failed to create campaign" });
      return;
    }

    await logAdminAction(admin.id, "create_campaign", "campaign", campaign.id, undefined, {
      campaignTitle,
    });

    res.json({
      campaign,
      projectId,
      // Only returned ONCE at creation time — admin must copy/share this immediately,
      // it is never retrievable again after this response.
      generatedCredentials,
    });
  } catch (err: any) {
    console.error("Campaign creation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/campaigns/:id/status — activate, pause, resume, complete, or soft-delete a campaign
router.put("/campaigns/:id/status", async (req, res: Response) => {
  const admin = (req as unknown as AuthRequest).user;
  const { id } = req.params;
  const { status } = req.body; // 'active' | 'paused' | 'completed' | 'deleted'

  if (!["active", "paused", "completed", "deleted"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const { data, error } = await supabase
    .from("bounties")
    .update({ status })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const actionMap: Record<string, string> = {
    active: "resume_campaign",
    paused: "pause_campaign",
    completed: "complete_campaign",
    deleted: "delete_campaign",
  };

  await logAdminAction(admin.id, actionMap[status], "campaign", id);

  res.json({ campaign: data });
});

// GET /admin/campaigns — list all campaigns with summary stats
router.get("/campaigns", async (_req, res: Response) => {
  const { data: campaigns, error } = await supabase
    .from("bounties")
    .select("*, projects(name, logo_url)")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Attach quick stats per campaign — participant count, total verified videos
  const campaignIds = (campaigns ?? []).map((c) => c.id);
  const { data: analysisStats } = await supabase
    .from("video_analysis")
    .select("campaign_id, creator_id, status, leaderboard_eligible")
    .in("campaign_id", campaignIds);

  const statsMap = new Map<string, { participants: Set<string>; verified: number; eligible: number }>();
  for (const row of analysisStats ?? []) {
    if (!statsMap.has(row.campaign_id)) {
      statsMap.set(row.campaign_id, { participants: new Set(), verified: 0, eligible: 0 });
    }
    const s = statsMap.get(row.campaign_id)!;
    s.participants.add(row.creator_id);
    if (row.status === "completed") s.verified++;
    if (row.leaderboard_eligible) s.eligible++;
  }

  const enriched = (campaigns ?? []).map((c) => ({
    ...c,
    stats: {
      participantCount: statsMap.get(c.id)?.participants.size ?? 0,
      verifiedVideos: statsMap.get(c.id)?.verified ?? 0,
      eligibleVideos: statsMap.get(c.id)?.eligible ?? 0,
    },
  }));

  res.json({ campaigns: enriched });
});

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────

// GET /admin/users — list all users with filters
router.get("/users", async (req, res: Response) => {
  const { role, status, search } = req.query;

  let query = supabase.from("users").select("*").order("created_at", { ascending: false });

  if (role) query = query.eq("role", role as string);
  if (status) query = query.eq("account_status", status as string);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ users: data });
});

// PUT /admin/users/:id/restrict — restrict a user account
router.put("/users/:id/restrict", async (req, res: Response) => {
  const admin = (req as unknown as AuthRequest).user;
  const { id } = req.params;
  const { reason } = req.body;

  const { error } = await supabase
    .from("users")
    .update({
      account_status: "restricted",
      restricted_reason: reason,
      restricted_at: new Date().toISOString(),
      restricted_by: admin.id,
    })
    .eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await logAdminAction(admin.id, "restrict_user", "user", id, reason);
  res.json({ success: true });
});

// PUT /admin/users/:id/ban — ban a user account
router.put("/users/:id/ban", async (req, res: Response) => {
  const admin = (req as unknown as AuthRequest).user;
  const { id } = req.params;
  const { reason } = req.body;

  const { error } = await supabase
    .from("users")
    .update({
      account_status: "banned",
      restricted_reason: reason,
      restricted_at: new Date().toISOString(),
      restricted_by: admin.id,
    })
    .eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Also revoke their Supabase session so they're kicked out immediately
  await supabase.auth.admin.deleteUser(id, false); // false = don't hard-delete, just revoke sessions
  // Note: depending on Supabase version, you may need signOut via admin API instead —
  // verify this behaves as "revoke session" not "delete account" before relying on it.

  await logAdminAction(admin.id, "ban_user", "user", id, reason);
  res.json({ success: true });
});

// PUT /admin/users/:id/unban — restore a banned/restricted account
router.put("/users/:id/unban", async (req, res: Response) => {
  const admin = (req as unknown as AuthRequest).user;
  const { id } = req.params;

  const { error } = await supabase
    .from("users")
    .update({
      account_status: "active",
      restricted_reason: null,
      restricted_at: null,
      restricted_by: null,
    })
    .eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await logAdminAction(admin.id, "unban_user", "user", id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// PLATFORM METRICS
// ─────────────────────────────────────────────

// GET /admin/metrics — platform-wide overview stats
router.get("/metrics", async (_req, res: Response) => {
  const [
    { count: totalUsers },
    { count: totalCreators },
    { count: activeCampaigns },
    { count: totalVideosAnalyzed },
    { data: scoreStats },
  ] = await Promise.all([
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("users").select("*", { count: "exact", head: true }).eq("role", "creator"),
    supabase.from("bounties").select("*", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("video_analysis").select("*", { count: "exact", head: true }).eq("status", "completed"),
    supabase.from("video_analysis").select("authenticity_score, final_score, status, leaderboard_eligible"),
  ]);

  const completed = (scoreStats ?? []).filter((s) => s.status === "completed");
  const avgAuthenticity = completed.length
    ? completed.reduce((sum, s) => sum + (s.authenticity_score ?? 0), 0) / completed.length
    : 0;
  const eligibleCount = completed.filter((s) => s.leaderboard_eligible).length;
  const quarantinedCount = (scoreStats ?? []).filter((s) => s.status === "quarantined").length;
  const failedCount = (scoreStats ?? []).filter((s) => s.status === "failed").length;

  res.json({
    metrics: {
      totalUsers: totalUsers ?? 0,
      totalCreators: totalCreators ?? 0,
      activeCampaigns: activeCampaigns ?? 0,
      totalVideosAnalyzed: totalVideosAnalyzed ?? 0,
      avgAuthenticityScore: Math.round(avgAuthenticity),
      eligibleVideos: eligibleCount,
      quarantinedVideos: quarantinedCount,
      failedVerifications: failedCount,
      verificationPassRate: completed.length
        ? Math.round((eligibleCount / completed.length) * 100)
        : 0,
    },
  });
});

// GET /admin/trending-videos — top performing videos platform-wide right now
router.get("/trending-videos", async (_req, res: Response) => {
  const { data, error } = await supabase
    .from("video_analysis")
    .select(`
      *,
      tiktok_posts:video_id ( title, cover_image_url, view_count, like_count ),
      users:creator_id ( name, avatar )
    `)
    .eq("status", "completed")
    .eq("leaderboard_eligible", true)
    .order("final_score", { ascending: false })
    .limit(20);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ videos: data });
});

export default router;

// GET /admin/audit-log — all admin actions, newest first
router.get("/audit-log", async (_req, res: Response) => {
  const { data, error } = await supabase
    .from("admin_actions")
    .select(`
      *,
      users:admin_id ( name, email )
    `)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ actions: data ?? [] });
});