// src/lib/instagram.ts
import dotenv from "dotenv";
dotenv.config();

export const IG_APP_ID     = process.env.INSTAGRAM_APP_ID!;
export const IG_APP_SECRET = process.env.INSTAGRAM_APP_SECRET!;
export const IG_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI
  ?? "https://zerra-backend-ms4p.onrender.com/auth/instagram/callback";

// ── OAuth ──────────────────────────────────────────────────────────────────

export function getInstagramAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id:     IG_APP_ID,
    redirect_uri:  IG_REDIRECT_URI,
    scope: [
      "instagram_basic",
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_manage_insights",
      "pages_read_engagement",
      "pages_show_list",
    ].join(","),
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
}

export interface IGTokenResponse {
  access_token:  string;
  token_type:    string;
  expires_in?:   number;
}

export async function exchangeInstagramCode(code: string): Promise<IGTokenResponse> {
  const res = await fetch("https://graph.facebook.com/v19.0/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     IG_APP_ID,
      client_secret: IG_APP_SECRET,
      redirect_uri:  IG_REDIRECT_URI,
      code,
    }),
  });

  const data = await res.json() as IGTokenResponse & { error?: { message: string } };
  if (!res.ok || data.error) {
    throw new Error(data.error?.message ?? "Instagram token exchange failed");
  }
  return data;
}

// Exchange short-lived token for a long-lived one (valid 60 days)
export async function getLongLivedToken(shortToken: string): Promise<IGTokenResponse> {
  const params = new URLSearchParams({
    grant_type:        "fb_exchange_token",
    client_id:         IG_APP_ID,
    client_secret:     IG_APP_SECRET,
    fb_exchange_token: shortToken,
  });

  const res  = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`);
  const data = await res.json() as IGTokenResponse & { error?: { message: string } };
  if (!res.ok || data.error) {
    throw new Error(data.error?.message ?? "Failed to get long-lived token");
  }
  return data;
}

// ── User & Pages ───────────────────────────────────────────────────────────

export interface IGPage {
  id:           string;
  name:         string;
  access_token: string;
}

// Get the Facebook Pages this user manages
export async function getFacebookPages(accessToken: string): Promise<IGPage[]> {
  const res  = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${accessToken}`
  );
  const data = await res.json() as { data: IGPage[]; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to fetch pages");
  return data.data ?? [];
}

// Get the Instagram Business Account linked to a Facebook Page
export async function getIGBusinessAccount(pageId: string, pageToken: string): Promise<{
  ig_id: string; username: string; name: string; followers_count: number; profile_picture_url: string;
} | null> {
  const res  = await fetch(
    `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account{id,username,name,followers_count,profile_picture_url}&access_token=${pageToken}`
  );
  const data = await res.json() as {
    instagram_business_account?: {
      id: string; username: string; name: string;
      followers_count: number; profile_picture_url: string;
    };
    error?: { message: string };
  };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to fetch IG account");
  if (!data.instagram_business_account) return null;
  return {
    ig_id:               data.instagram_business_account.id,
    username:            data.instagram_business_account.username,
    name:                data.instagram_business_account.name,
    followers_count:     data.instagram_business_account.followers_count,
    profile_picture_url: data.instagram_business_account.profile_picture_url,
  };
}

// ── Media / Analytics ─────────────────────────────────────────────────────

export interface IGMedia {
  id:            string;
  caption?:      string;
  media_type:    string;
  media_url?:    string;
  thumbnail_url?: string;
  timestamp:     string;
  like_count:    number;
  comments_count: number;
}

export async function getIGMedia(igAccountId: string, accessToken: string): Promise<IGMedia[]> {
  const fields = "id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count";
  const res    = await fetch(
    `https://graph.facebook.com/v19.0/${igAccountId}/media?fields=${fields}&limit=25&access_token=${accessToken}`
  );
  const data   = await res.json() as { data: IGMedia[]; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to fetch media");
  return data.data ?? [];
}

export interface IGInsights {
  impressions:   number;
  reach:         number;
  profile_views: number;
  follower_count: number;
}

export async function getIGInsights(igAccountId: string, accessToken: string): Promise<IGInsights> {
  const metrics = "impressions,reach,profile_views,follower_count";
  const since   = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // last 30 days
  const until   = Math.floor(Date.now() / 1000);

  const res  = await fetch(
    `https://graph.facebook.com/v19.0/${igAccountId}/insights?metric=${metrics}&period=day&since=${since}&until=${until}&access_token=${accessToken}`
  );
  const data = await res.json() as {
    data: { name: string; values: { value: number }[] }[];
    error?: { message: string };
  };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to fetch insights");

  const get = (name: string) => {
    const metric = data.data?.find((d) => d.name === name);
    const vals   = metric?.values ?? [];
    return vals.reduce((sum, v) => sum + (Number(v.value) || 0), 0);
  };

  return {
    impressions:    get("impressions"),
    reach:          get("reach"),
    profile_views:  get("profile_views"),
    follower_count: get("follower_count"),
  };
}

// ── Content Publishing ─────────────────────────────────────────────────────

// Step 1 — Create a media container
export async function createIGMediaContainer(
  igAccountId: string,
  accessToken: string,
  opts: {
    image_url?: string;     // for IMAGE posts
    video_url?: string;     // for VIDEO/REELS posts
    caption?: string;
    media_type?: "IMAGE" | "VIDEO" | "REELS";
    is_carousel_item?: boolean;
  }
): Promise<string> { // returns container id
  const body = new URLSearchParams({
    ...(opts.image_url  && { image_url: opts.image_url }),
    ...(opts.video_url  && { video_url: opts.video_url }),
    ...(opts.caption    && { caption: opts.caption }),
    ...(opts.media_type && { media_type: opts.media_type }),
    ...(opts.is_carousel_item && { is_carousel_item: "true" }),
    access_token: accessToken,
  });

  const res  = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media`, {
    method: "POST", body,
  });
  const data = await res.json() as { id?: string; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to create media container");
  return data.id!;
}

// Step 2 — Publish the container
export async function publishIGMedia(
  igAccountId: string,
  accessToken: string,
  containerId: string
): Promise<string> { // returns published media id
  const body = new URLSearchParams({
    creation_id:  containerId,
    access_token: accessToken,
  });

  const res  = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media_publish`, {
    method: "POST", body,
  });
  const data = await res.json() as { id?: string; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to publish media");
  return data.id!;
}