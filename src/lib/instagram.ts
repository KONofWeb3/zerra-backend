// src/lib/instagram.ts
//
// Instagram API with Instagram Login (business login) — NOT the legacy
// Facebook Login for Business flow. The user connects their Instagram
// Professional (Business/Creator) account directly; there is no Facebook
// Page in the middle, so no page-linking step is needed.
import dotenv from "dotenv";
dotenv.config();

export const IG_APP_ID     = process.env.INSTAGRAM_APP_ID!;
export const IG_APP_SECRET = process.env.INSTAGRAM_APP_SECRET!;
export const IG_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI
  ?? "https://zerra-backend-ms4p.onrender.com/auth/instagram/callback";

// Scopes registered on the "Instagram API" use case (API setup with
// Instagram login) — keep this in sync with the Permissions and features
// page in the Meta dashboard.
const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];

// ── OAuth ──────────────────────────────────────────────────────────────────

export function getInstagramAuthUrl(state: string): string {
  const params = new URLSearchParams({
    force_reauth:  "true",
    client_id:     IG_APP_ID,
    redirect_uri:  IG_REDIRECT_URI,
    response_type: "code",
    scope:         IG_SCOPES.join(","),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

export interface IGShortTokenResponse {
  access_token: string;
  user_id:      string; // Instagram-scoped user id — this IS the ig account id, no Page lookup needed
  permissions?: string;
}

// Step 1 — exchange the ?code= for a short-lived (1hr) access token.
// Note: this hits api.instagram.com, not graph.facebook.com.
export async function exchangeInstagramCode(code: string): Promise<IGShortTokenResponse> {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     IG_APP_ID,
      client_secret: IG_APP_SECRET,
      grant_type:    "authorization_code",
      redirect_uri:  IG_REDIRECT_URI,
      code,
    }),
  });

  const data = await res.json() as IGShortTokenResponse & { error_message?: string; error_type?: string };
  if (!res.ok || (data as any).error_type) {
    throw new Error(data.error_message ?? "Instagram token exchange failed");
  }
  return data;
}

export interface IGLongTokenResponse {
  access_token: string;
  token_type:   string;
  expires_in:   number; // seconds, ~60 days
}

// Step 2 — exchange the short-lived token for a long-lived one (60 days).
// Hits graph.instagram.com, not graph.facebook.com.
export async function getLongLivedToken(shortToken: string): Promise<IGLongTokenResponse> {
  const params = new URLSearchParams({
    grant_type:    "ig_exchange_token",
    client_secret: IG_APP_SECRET,
    access_token:  shortToken,
  });

  const res  = await fetch(`https://graph.instagram.com/access_token?${params}`);
  const data = await res.json() as IGLongTokenResponse & { error?: { message: string } };
  if (!res.ok || data.error) {
    throw new Error(data.error?.message ?? "Failed to get long-lived token");
  }
  return data;
}

// Refresh a long-lived token before it expires (valid once the token is
// at least 24h old, refreshes for another 60 days). Not wired into a route
// yet — call this from a scheduled job before `expires_at`.
export async function refreshLongLivedToken(currentToken: string): Promise<IGLongTokenResponse> {
  const params = new URLSearchParams({
    grant_type:   "ig_refresh_token",
    access_token: currentToken,
  });

  const res  = await fetch(`https://graph.instagram.com/refresh_access_token?${params}`);
  const data = await res.json() as IGLongTokenResponse & { error?: { message: string } };
  if (!res.ok || data.error) {
    throw new Error(data.error?.message ?? "Failed to refresh token");
  }
  return data;
}

// ── Profile ────────────────────────────────────────────────────────────────

export interface IGProfile {
  ig_id:               string;
  username:            string;
  account_type:        string; // "BUSINESS" | "CREATOR" | "PERSONAL"
  followers_count:     number;
  profile_picture_url: string | null;
}

// Get the connected account's own profile — no Page lookup, this IS the
// Instagram Professional account the user just authorized.
export async function getIGProfile(igUserId: string, accessToken: string): Promise<IGProfile> {
  const fields = "id,username,account_type,followers_count,profile_picture_url";
  const res  = await fetch(
    `https://graph.instagram.com/v21.0/${igUserId}?fields=${fields}&access_token=${accessToken}`
  );
  const data = await res.json() as {
    id: string; username: string; account_type: string;
    followers_count?: number; profile_picture_url?: string;
    error?: { message: string };
  };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to fetch Instagram profile");
  return {
    ig_id:               data.id,
    username:            data.username,
    account_type:        data.account_type,
    followers_count:     data.followers_count ?? 0,
    profile_picture_url: data.profile_picture_url ?? null,
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
    `https://graph.instagram.com/v21.0/${igAccountId}/media?fields=${fields}&limit=25&access_token=${accessToken}`
  );
  const data   = await res.json() as { data: IGMedia[]; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to fetch media");
  return data.data ?? [];
}

export interface IGInsights {
  reach:         number;
  profile_views: number;
  follower_count: number;
}

export async function getIGInsights(igAccountId: string, accessToken: string): Promise<IGInsights> {
  // "impressions" was deprecated for the Instagram API with Instagram Login —
  // reach, profile_views and follower_count remain.
  const metrics = "reach,profile_views,follower_count";
  const since   = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // last 30 days
  const until   = Math.floor(Date.now() / 1000);

  const res  = await fetch(
    `https://graph.instagram.com/v21.0/${igAccountId}/insights?metric=${metrics}&period=day&since=${since}&until=${until}&access_token=${accessToken}`
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

  const res  = await fetch(`https://graph.instagram.com/v21.0/${igAccountId}/media`, {
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

  const res  = await fetch(`https://graph.instagram.com/v21.0/${igAccountId}/media_publish`, {
    method: "POST", body,
  });
  const data = await res.json() as { id?: string; error?: { message: string } };
  if (!res.ok || data.error) throw new Error(data.error?.message ?? "Failed to publish media");
  return data.id!;
}
