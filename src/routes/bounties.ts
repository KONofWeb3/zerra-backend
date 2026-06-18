import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

const router = Router();

// GET /bounties — list all live bounties
router.get("/", async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from("bounties")
    .select("*")
    .eq("status", "live")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ bounties: data });
});

// GET /bounties/:id — single bounty
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("bounties")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    res.status(404).json({ error: "Bounty not found" });
    return;
  }

  res.json({ bounty: data });
});

// POST /bounties/:id/claim — creator claims a bounty
router.post("/:id/claim", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as AuthRequest).user;

  // Check bounty exists and is live
  const { data: bounty, error: bountyError } = await supabase
    .from("bounties")
    .select("*")
    .eq("id", id)
    .eq("status", "live")
    .single();

  if (bountyError || !bounty) {
    res.status(404).json({ error: "Bounty not found or no longer live" });
    return;
  }

  // Check user hasn't already claimed this bounty
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

  // Add this route to src/routes/bounties.ts
// POST /bounties/:id/join — creator joins a campaign (creates a claim record)
router.post("/:id/join", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { id } = req.params;

  // Check TikTok is connected
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

  // Check campaign exists and is active
  const { data: bounty } = await supabase
    .from("bounties")
    .select("id, status")
    .eq("id", id)
    .single();

  if (!bounty || bounty.status !== "active") {
    res.status(400).json({ error: "Campaign is not currently active" });
    return;
  }

  // Upsert the claim (idempotent — joining twice is fine)
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
  // Create the claim
  const { data: claim, error: claimError } = await supabase
    .from("claims")
    .insert({
      user_id: user.id,
      bounty_id: id,
      status: "pending",
    })
    .select()
    .single();

  if (claimError) {
    res.status(500).json({ error: claimError.message });
    return;
  }

  res.status(201).json({ claim });
});

export default router;