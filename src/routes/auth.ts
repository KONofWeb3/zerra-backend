import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { supabase } from "../lib/supabase";
import { AuthRequest } from "../types";
import {
  getTikTokAuthUrl,
  exchangeTikTokCode,
  getTikTokUser,
} from "../lib/tiktok";
import { calculateAndStoreInfluenceScore } from "../lib/scoringData";
import { syncTikTokPosts } from "../lib/syncTikTok";
import crypto from "crypto";

const router = Router();

// GET /auth/tiktok — redirect user to TikTok login
router.get("/tiktok", requireAuth, (req: Request, res: Response) => {
  const state = Buffer.from(
    JSON.stringify({
      token: req.query.token as string,
      nonce: crypto.randomBytes(8).toString("hex"),
    })
  ).toString("base64");

  const url = getTikTokAuthUrl(state);
  res.redirect(url);
});

// POST /auth/referral/apply — record a referral after signup completes
router.post("/referral/apply", requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const { referralCode } = req.body as { referralCode: string };

  if (!referralCode) {
    res.status(400).json({ error: "referralCode is required" });
    return;
  }

  const { data: existing } = await supabase
    .from("referrals")
    .select("id")
    .eq("referred_id", user.id)
    .single();

  if (existing) {
    res.json({ success: true, message: "Already recorded" });
    return;
  }

  const { data: userData } = await supabase
    .from("users")
    .select("referred_by, referral_code")
    .eq("id", user.id)
    .single();

  if (userData?.referred_by) {
    res.json({ success: true, message: "Already recorded" });
    return;
  }

  if (userData?.referral_code === referralCode) {
    res.status(400).json({ error: "Cannot refer yourself" });
    return;
  }

  const { data: referrer } = await supabase
    .from("users")
    .select("id")
    .eq("referral_code", referralCode)
    .single();

  if (!referrer) {
    res.status(404).json({ error: "Invalid referral code" });
    return;
  }

  const { error: referralError } = await supabase
    .from("referrals")
    .insert({ referrer_id: referrer.id, referred_id: user.id });

  if (referralError && referralError.code !== "23505") {
    res.status(500).json({ error: referralError.message });
    return;
  }

  await supabase
    .from("users")
    .update({ referred_by: referrer.id })
    .eq("id", user.id);

  res.json({ success: true });
});

// GET /auth/tt/callback
router.get("/tt/callback", async (req: Request, res: Response) => {
  const { code, error, state } = req.query;

  if (error || !code || !state) {
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_denied`);
    return;
  }

  try {
    const decoded = JSON.parse(Buffer.from(state as string, "base64").toString());
    const token   = decoded.token;

    if (!token) {
      res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
      return;
    }

    const { data, error: authError } = await supabase.auth.getUser(token);
    if (authError || !data.user) {
      res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
      return;
    }

    const user = data.user;

    const tokens = await exchangeTikTokCode(code as string);

    let username      = `tiktok_${tokens.open_id.slice(0, 8)}`;
    let displayName   = username;
    let avatarUrl     = null;
    let followerCount = 0;

    try {
      const tiktokUser = await getTikTokUser(tokens.access_token);
      console.log("TikTok user data received:", JSON.stringify(tiktokUser));
      username      = tiktokUser.username     || tiktokUser.display_name || username;
      displayName   = tiktokUser.display_name || username;
      avatarUrl     = tiktokUser.avatar_url   || null;
      followerCount = tiktokUser.follower_count ?? 0;
    } catch (err: any) {
      console.warn("Could not fetch TikTok user info:", err.message);
    }

    const { error: dbError } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id:          user.id,
          platform:         "tiktok",
          platform_user_id: tokens.open_id,
          username,
          follower_count:   followerCount,
          access_token:     tokens.access_token,
          refresh_token:    tokens.refresh_token,
          expires_at:       new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        },
        { onConflict: "user_id,platform" }
      );

    if (dbError) throw dbError;

    const { error: usersError } = await supabase
      .from("users")
      .update({ tiktok_username: username })
      .eq("id", user.id);

    if (usersError) {
      console.error("Failed to update users.tiktok_username:", usersError.message);
    }

    // Sync their videos immediately — previously this only ever ran from a
    // manual "Sync" button on an unrelated page, so Analytics stayed on
    // "No data yet, sync first" forever unless someone found that button.
    try {
      await syncTikTokPosts(user.id);
    } catch (err: any) {
      console.error("Failed to sync TikTok posts after connect:", err.message);
    }

    // Calculate the Influence Rating now, before redirecting, so it's
    // already non-zero (and reflects real engagement, not just followers)
    // by the time the frontend lands back on Settings.
    try {
      await calculateAndStoreInfluenceScore(user.id);
    } catch (err: any) {
      console.error("Failed to calculate influence score after TikTok connect:", err.message);
    }

    res.redirect(`${process.env.FRONTEND_URL}/settings?connected=tiktok`);
  } catch (err: any) {
    console.error("TikTok callback error:", err.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
  }
});

export default router;