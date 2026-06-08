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

// PUT /me/profile — update name, username
router.put("/profile", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { name, username } = req.body;

  if (!name && !username) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  // Check username uniqueness if provided
  if (username) {
    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .neq("id", user.id)
      .single();

    if (existing) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }
  }

  const updates: Record<string, string> = {};
  if (name)     updates.name     = name.trim();
  if (username) updates.username = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");

  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ user: data });
});

// PUT /me/notifications — save notification preferences
router.put("/notifications", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { email, push, campaigns } = req.body;

  const { data, error } = await supabase
    .from("users")
    .update({
      notifications_prefs: { email, push, campaigns },
    })
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ user: data });
});

// PUT /me/privacy — save privacy settings
router.put("/privacy", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { public_profile } = req.body;

  const { data, error } = await supabase
    .from("users")
    .update({
      privacy_settings: { public_profile },
    })
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ user: data });
});

// PUT /me/password — change password via Supabase Auth
router.put("/password", requireAuth, async (req, res: Response) => {
  const { new_password } = req.body;

  if (!new_password || new_password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const { error } = await supabase.auth.admin.updateUserById(
    (req as AuthRequest).user.id,
    { password: new_password }
  );

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ success: true });
});

// PUT /me/wallet — save wallet address
router.put("/wallet", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { wallet_address, wallet_chain } = req.body;

  if (!wallet_address) {
    res.status(400).json({ error: "Wallet address is required" });
    return;
  }

  const { data, error } = await supabase
    .from("users")
    .update({ wallet_address, wallet_chain: wallet_chain ?? "ethereum" })
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ user: data });
});
export default router;