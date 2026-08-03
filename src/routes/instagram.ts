// src/routes/instagram.ts
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import {
  getInstagramAuthUrl,
  exchangeInstagramCode,
  getLongLivedToken,
  getFacebookPages,
  getIGBusinessAccount,
  getIGMedia,
  getIGInsights,
  createIGMediaContainer,
  publishIGMedia,
} from "../lib/instagram";
import { deleteFile } from "../lib/r2";
import crypto from "crypto";

const router = Router();

// GET /auth/instagram — redirect user to Facebook/Instagram OAuth
router.get("/", requireAuth, (req: Request, res: Response) => {
  const token = req.query.token as string;
  const state = Buffer.from(
    JSON.stringify({ token, nonce: crypto.randomBytes(8).toString("hex") })
  ).toString("base64");
  res.redirect(getInstagramAuthUrl(state));
});

// GET /auth/instagram/callback — handle the OAuth redirect
router.get("/callback", async (req: Request, res: Response) => {
  const { code, error, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL!;

  if (error || !code || !state) {
    res.redirect(`${frontendUrl}/settings?error=instagram_denied`);
    return;
  }

  try {
    const decoded = JSON.parse(Buffer.from(state as string, "base64").toString());
    const token   = decoded.token;

    if (!token) {
      res.redirect(`${frontendUrl}/settings?error=instagram_failed`);
      return;
    }

    const { data, error: authError } = await supabase.auth.getUser(token);
    if (authError || !data.user) {
      res.redirect(`${frontendUrl}/settings?error=instagram_failed`);
      return;
    }
    const user = data.user;

    // Exchange code → short-lived token → long-lived token (60 days)
    const shortToken = await exchangeInstagramCode(code as string);
    const longToken  = await getLongLivedToken(shortToken.access_token);
    const expiresAt  = new Date(Date.now() + (longToken.expires_in ?? 5184000) * 1000).toISOString();

    // Find the first Facebook Page with a linked Instagram Business Account
    const pages = await getFacebookPages(longToken.access_token);
    let igAccount = null;
    let pageAccessToken = longToken.access_token;

    for (const page of pages) {
      const account = await getIGBusinessAccount(page.id, page.access_token);
      if (account) {
        igAccount        = account;
        pageAccessToken  = page.access_token;
        break;
      }
    }

    if (!igAccount) {
      // User authenticated but has no Instagram Business Account linked to a Facebook Page
      res.redirect(`${frontendUrl}/settings?error=instagram_no_business_account`);
      return;
    }

    // Save to social_accounts
    const { error: dbError } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id:          user.id,
          platform:         "instagram",
          platform_user_id: igAccount.ig_id,
          username:         igAccount.username,
          follower_count:   igAccount.followers_count,
          access_token:     pageAccessToken, // page token for Graph API calls
          refresh_token:    longToken.access_token, // user token for refreshing
          expires_at:       expiresAt,
          metadata: JSON.stringify({
            name:                igAccount.name,
            profile_picture_url: igAccount.profile_picture_url,
          }),
        },
        { onConflict: "user_id,platform" }
      );

    if (dbError) throw dbError;

    // Also store username on users table for quick display in sidebar
    await supabase
      .from("users")
      .update({ instagram_username: igAccount.username })
      .eq("id", user.id);

    res.redirect(`${frontendUrl}/settings?connected=instagram`);
  } catch (err: any) {
    console.error("Instagram callback error:", err.message);
    res.redirect(`${frontendUrl}/settings?error=instagram_failed`);
  }
});

// GET /auth/instagram/media — fetch this user's recent Instagram posts
router.get("/media", requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data: account } = await supabase
    .from("social_accounts")
    .select("platform_user_id, access_token")
    .eq("user_id", user.id)
    .eq("platform", "instagram")
    .single();

  if (!account) {
    res.status(400).json({ error: "Instagram account not connected" });
    return;
  }

  try {
    const media = await getIGMedia(account.platform_user_id, account.access_token);
    res.json({ media });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/instagram/insights — fetch account-level insights for this user
router.get("/insights", requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;

  const { data: account } = await supabase
    .from("social_accounts")
    .select("platform_user_id, access_token")
    .eq("user_id", user.id)
    .eq("platform", "instagram")
    .single();

  if (!account) {
    res.status(400).json({ error: "Instagram account not connected" });
    return;
  }

  try {
    const insights = await getIGInsights(account.platform_user_id, account.access_token);
    res.json({ insights });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/instagram/publish — publish a post directly to Instagram from Zerra
router.post("/publish", requireAuth, async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const { image_url, video_url, caption, media_type } = req.body as {
    image_url?: string;
    video_url?: string;
    caption?: string;
    media_type?: "IMAGE" | "VIDEO" | "REELS";
  };

  if (!image_url && !video_url) {
    res.status(400).json({ error: "image_url or video_url is required" });
    return;
  }

  const { data: account } = await supabase
    .from("social_accounts")
    .select("platform_user_id, access_token")
    .eq("user_id", user.id)
    .eq("platform", "instagram")
    .single();

  if (!account) {
    res.status(400).json({ error: "Instagram account not connected" });
    return;
  }

  try {
    // Step 1: create container
    const containerId = await createIGMediaContainer(
      account.platform_user_id,
      account.access_token,
      { image_url, video_url, caption, media_type: media_type ?? (video_url ? "REELS" : "IMAGE") }
    );

    // Step 2: publish (Instagram recommends waiting a few seconds for video processing)
    if (video_url) {
      await new Promise((r) => setTimeout(r, 5000));
    }
    const mediaId = await publishIGMedia(account.platform_user_id, account.access_token, containerId);

    // Clean up the R2 file now that Instagram has fetched it —
    // keeps storage usage near zero since files are only needed temporarily
    const r2Key = req.body.r2Key as string | undefined;
    if (r2Key) {
      deleteFile(r2Key).catch((err) =>
        console.error("Failed to delete R2 file after publish:", err.message)
      );
    }

    res.json({ success: true, mediaId });
  } catch (err: any) {
    console.error("Instagram publish error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;