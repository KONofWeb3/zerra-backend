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