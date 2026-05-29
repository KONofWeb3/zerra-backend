import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
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
  const state = crypto.randomBytes(16).toString("hex");
  const url = getTikTokAuthUrl(state);
  res.redirect(url);
});

// GET /auth/tiktok/callback — TikTok redirects here after login
router.get("/tiktok/callback", requireAuth, async (req: Request, res: Response) => {
  const { code, error } = req.query;

  if (error || !code) {
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_denied`);
    return;
  }

  try {
    const user = (req as AuthRequest).user;

    // Exchange code for tokens
    const tokens = await exchangeTikTokCode(code as string);

    // Get TikTok user profile
 const tiktokUser = await getTikTokUser(tokens.access_token);
    // Save to social_accounts table
    const { error: dbError } = await supabase
      .from("social_accounts")
      .upsert({
        user_id: user.id,
        platform: "tiktok",
        platform_user_id: tokens.open_id,
        username: tiktokUser.username || tiktokUser.display_name,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString(),
      }, { onConflict: "user_id,platform" });

    if (dbError) throw dbError;

    res.redirect(`${process.env.FRONTEND_URL}/settings?connected=tiktok`);
  } catch (err: any) {
    console.error("TikTok callback error:", err.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
  }
});

export default router;