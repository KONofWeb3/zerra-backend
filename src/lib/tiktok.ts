import dotenv from "dotenv";
dotenv.config();

export const TIKTOK_CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY!;
export const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET!;
export const TIKTOK_REDIRECT_URI  = process.env.TIKTOK_REDIRECT_URI!;

interface TikTokTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  open_id: string;
  error?: string;
  error_description?: string;
}

interface TikTokUserResponse {
  data: {
    user: {
      open_id: string;
      username: string;
      display_name: string;
      avatar_url: string;
    };
  };
  error?: {
    message: string;
    code?: string;
  };
}

export function getTikTokAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    scope: "user.info.profile,user.info.stats,video.list",
    response_type: "code",
    redirect_uri: TIKTOK_REDIRECT_URI,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize?${params.toString()}`;
}

export async function exchangeTikTokCode(code: string): Promise<TikTokTokenResponse> {
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: TIKTOK_REDIRECT_URI,
    }),
  });

  const data = await res.json() as TikTokTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(data.error_description || "TikTok token exchange failed");
  }
  return data;
}

export async function getTikTokUser(accessToken: string): Promise<{
  open_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
}> {
  const res = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name,avatar_url",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const data = await res.json() as TikTokUserResponse;
  console.log("TikTok user response status:", res.status);
  console.log("TikTok user response body:", JSON.stringify(data));

 if (!res.ok || (data.error && data.error.code !== "ok")) {
    throw new Error(data.error?.message || "Failed to fetch TikTok user");
  }
  return data.data.user;
}

interface TikTokVideoResponse {
  data: {
    videos: {
      id: string;
      title: string;
      cover_image_url: string;
      video_description: string;
      view_count: number;
      like_count: number;
      comment_count: number;
      share_count: number;
      embed_link: string;
    }[];
    cursor: number;
    has_more: boolean;
  };
  error?: {
    message: string;
    code?: string;
  };
}

export async function getTikTokVideos(accessToken: string): Promise<
  TikTokVideoResponse["data"]["videos"]
> {
  const res = await fetch(
    "https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,video_description,view_count,like_count,comment_count,share_count,embed_link",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_count: 20 }),
    }
  );

  const data = (await res.json()) as TikTokVideoResponse;
  console.log("TikTok videos response status:", res.status);
  console.log("TikTok videos response body:", JSON.stringify(data));

 if (!res.ok || (data.error && data.error.code !== "ok")) {
    throw new Error(data.error?.message || "Failed to fetch TikTok videos");
  }
  return data.data?.videos ?? [];
}