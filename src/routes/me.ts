import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

const router = Router();

// GET /me
router.get("/", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ user: data });
});

// GET /me/social-accounts
router.get("/social-accounts", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data, error } = await supabase
    .from("social_accounts")
    .select("id, platform, username, expires_at, created_at")
    .eq("user_id", user.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ accounts: data });
});

// DELETE /me/social-accounts/:id
router.delete("/social-accounts/:id", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { id } = req.params;

  const { error } = await supabase
    .from("social_accounts")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

export default router;