import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { supabase } from "../lib/supabase";
import {
  getTikTokAuthUrl,
  exchangeTikTokCode,
  getTikTokUser,
} from "../lib/tiktok";
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


// Add to src/routes/auth.ts (or a new referral route)
// Called from the frontend AFTER a new user completes email confirmation
// and lands on the app for the first time.

// POST /auth/referral/apply — record a referral after signup completes
// Body: { referralCode: string }
// Called once per new user, right after their first login.
router.post("/referral/apply", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { referralCode } = req.body as { referralCode: string };

  if (!referralCode) {
    res.status(400).json({ error: "referralCode is required" });
    return;
  }

  // Check if this user was already referred — prevent double-counting
  const { data: existing } = await supabase
    .from("referrals")
    .select("id")
    .eq("referred_id", user.id)
    .single();

  if (existing) {
    res.json({ success: true, message: "Already recorded" });
    return;
  }

  // Also check users.referred_by
  const { data: userData } = await supabase
    .from("users")
    .select("referred_by, referral_code")
    .eq("id", user.id)
    .single();

  if (userData?.referred_by) {
    res.json({ success: true, message: "Already recorded" });
    return;
  }

  // Don't let users refer themselves
  if (userData?.referral_code === referralCode) {
    res.status(400).json({ error: "Cannot refer yourself" });
    return;
  }

  // Find the referrer by their code
  const { data: referrer } = await supabase
    .from("users")
    .select("id")
    .eq("referral_code", referralCode)
    .single();

  if (!referrer) {
    res.status(404).json({ error: "Invalid referral code" });
    return;
  }

  // Record the referral
  const { error: referralError } = await supabase
    .from("referrals")
    .insert({
      referrer_id: referrer.id,
      referred_id: user.id,
    });

  if (referralError && referralError.code !== "23505") {
    res.status(500).json({ error: referralError.message });
    return;
  }

  // Mark the referred user so we know who sent them
  await supabase
    .from("users")
    .update({ referred_by: referrer.id })
    .eq("id", user.id);

  // When the founder decides on rewards, add points here:
  // await supabase.from("users")
  //   .update({ referral_points: supabase.rpc("increment", { x: REWARD_AMOUNT }) })
  //   .eq("id", referrer.id);

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

    // Exchange code for tokens
    const tokens = await exchangeTikTokCode(code as string);

    // Fetch user info — use display_name as fallback if username unavailable
    let username       = `tiktok_${tokens.open_id.slice(0, 8)}`;
    let displayName    = username;
    let avatarUrl       = null;
    let followerCount  = 0;

    try {
      const tiktokUser = await getTikTokUser(tokens.access_token);
      console.log("TikTok user data received:", JSON.stringify(tiktokUser));
      username       = tiktokUser.username    || tiktokUser.display_name || username;
      displayName    = tiktokUser.display_name || username;
      avatarUrl       = tiktokUser.avatar_url   || null;
      followerCount  = tiktokUser.follower_count ?? 0;
    } catch (err: any) {
      console.warn("Could not fetch TikTok user info:", err.message);
    }

    // Save to social_accounts — now also stores follower_count, which the
    // frontend reads via accounts.find(a => a.platform === 'tiktok')?.follower_count
    // to determine Influencer Badge eligibility.
    const { error: dbError } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id: user.id,
          platform: "tiktok",
          platform_user_id: tokens.open_id,
          username,
          follower_count: followerCount,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        },
        { onConflict: "user_id,platform" }
      );

    if (dbError) throw dbError;

    // CRITICAL FIX: the frontend's "TikTok: Connected/Not connected" display
    // (Settings sidebar, Dashboard header) reads users.tiktok_username via
    // GET /me — NOT social_accounts. The original callback only wrote to
    // social_accounts and never touched this field, so the UI never
    // reflected a successful connection even though the DB write succeeded.
    const { error: usersError } = await supabase
      .from("users")
      .update({ tiktok_username: username })
      .eq("id", user.id);

    if (usersError) {
      // Don't fail the whole flow over this — social_accounts is the
      // source of truth for actual functionality (sync, analytics).
      // tiktok_username on users is just a display convenience field.
      console.error("Failed to update users.tiktok_username:", usersError.message);
    }

    res.redirect(`${process.env.FRONTEND_URL}/settings?connected=tiktok`);
  } catch (err: any) {
    console.error("TikTok callback error:", err.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
  }
});

export default router;