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
  const state = Buffer.from(
    JSON.stringify({
      token: req.query.token as string,
      nonce: crypto.randomBytes(8).toString("hex"),
    })
  ).toString("base64");

  const url = getTikTokAuthUrl(state);
  res.redirect(url);
});

// GET /auth/tiktok/callback
router.get("/tt/callback", async (req: Request, res: Response) => {
  const { code, error, state } = req.query;

  if (error || !code || !state) {
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_denied`);
    return;
  }

  try {
    // Decode token from state
    const decoded = JSON.parse(
      Buffer.from(state as string, "base64").toString()
    );
    const token = decoded.token;

    if (!token) {
      res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
      return;
    }

    // Verify the Supabase token
    const { data, error: authError } = await supabase.auth.getUser(token);
    if (authError || !data.user) {
      res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
      return;
    }

    const user = data.user;

    // Exchange code for tokens
    const tokens = await exchangeTikTokCode(code as string);

    // In sandbox, user info fetch may fail — use open_id as fallback
    let username = `tiktok_${tokens.open_id.slice(0, 8)}`;
    try {
      const tiktokUser = await getTikTokUser(tokens.access_token);
      username = tiktokUser.username || tiktokUser.display_name || username;
    } catch {
      console.warn("Could not fetch TikTok user info, using open_id fallback");
    }

    // Save to social_accounts
    const { error: dbError } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id: user.id,
          platform: "tiktok",
          platform_user_id: tokens.open_id,
          username,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(
            Date.now() + tokens.expires_in * 1000
          ).toISOString(),
        },
        { onConflict: "user_id,platform" }
      );

    if (dbError) throw dbError;

    res.redirect(`${process.env.FRONTEND_URL}/settings?connected=tiktok`);
  } catch (err: any) {
    console.error("TikTok callback error:", err.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=tiktok_failed`);
  }
});

export default router;