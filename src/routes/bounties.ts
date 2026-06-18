import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

const router = Router();

// GET /bounties — list all active campaigns (status = 'active')
router.get("/", async (_req: Request, res: Response) => {
  const { data: campaigns, error } = await supabase
    .from("bounties")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Attach participant counts per campaign
  const ids = (campaigns ?? []).map((c) => c.id);
  const { data: claims } = await supabase
    .from("claims")
    .select("bounty_id, user_id")
    .in("bounty_id", ids);

  const statsMap = new Map<string, number>();
  for (const claim of claims ?? []) {
    statsMap.set(claim.bounty_id, (statsMap.get(claim.bounty_id) ?? 0) + 1);
  }

  const enriched = (campaigns ?? []).map((c) => ({
    ...c,
    stats: { participantCount: statsMap.get(c.id) ?? 0 },
  }));

  res.json({ campaigns: enriched });
});

// GET /bounties/:id — single campaign
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("bounties")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  res.json({ bounty: data });
});

// POST /bounties/:id/join — creator joins a campaign
router.post("/:id/join", requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const { id } = req.params;

  // Must have TikTok connected
  const { data: account } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("user_id", user.id)
    .eq("platform", "tiktok")
    .single();

  if (!account) {
    res.status(400).json({ error: "Connect your TikTok account before joining a campaign" });
    return;
  }

  // Campaign must be active
  const { data: bounty } = await supabase
    .from("bounties")
    .select("id, status")
    .eq("id", id)
    .single();

  if (!bounty || bounty.status !== "active") {
    res.status(400).json({ error: "Campaign is not currently active" });
    return;
  }

  // Upsert — joining twice is idempotent
  const { error } = await supabase
    .from("claims")
    .upsert(
      { user_id: user.id, bounty_id: id, status: "pending" },
      { onConflict: "user_id,bounty_id" }
    );

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

// POST /bounties/:id/claim — legacy claim endpoint (kept for backwards compat)
router.post("/:id/claim", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as AuthRequest).user;

  const { data: bounty, error: bountyError } = await supabase
    .from("bounties")
    .select("*")
    .eq("id", id)
    .eq("status", "active")
    .single();

  if (bountyError || !bounty) {
    res.status(404).json({ error: "Campaign not found or not active" });
    return;
  }

  const { data: existing } = await supabase
    .from("claims")
    .select("id")
    .eq("user_id", user.id)
    .eq("bounty_id", id)
    .single();

  if (existing) {
    res.status(409).json({ error: "You have already claimed this bounty" });
    return;
  }

  const { data: claim, error: claimError } = await supabase
    .from("claims")
    .insert({ user_id: user.id, bounty_id: id, status: "pending" })
    .select()
    .single();

  if (claimError) {
    res.status(500).json({ error: claimError.message });
    return;
  }

  res.status(201).json({ claim });
});

export default router;