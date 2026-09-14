// src/lib/twitter.ts
//
// X (Twitter) OAuth 2.0 + PKCE — the current standard flow for X API v2 user
// context auth. Same shape as lib/tiktok.ts. Needs a real X Developer App:
// TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET, TWITTER_REDIRECT_URI in env —
// none of that exists yet, so this is wired up but non-functional until a
// real app is registered and those are set in Render.

import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

export const TWITTER_CLIENT_ID     = process.env.TWITTER_CLIENT_ID!;
export const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET!;
export const TWITTER_REDIRECT_URI  = process.env.TWITTER_REDIRECT_URI!;

interface TwitterTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

interface TwitterUserResponse {
  data: {
    id: string;
    username: string;
    name: string;
    profile_image_url?: string;
    public_metrics: { followers_count: number };
  };
  errors?: { message: string }[];
}

/** PKCE code_verifier + its S256 code_challenge, per X's OAuth 2.0 requirements. */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function getTwitterAuthUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: TWITTER_CLIENT_ID,
    redirect_uri: TWITTER_REDIRECT_URI,
    scope: "tweet.read users.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
}

export async function exchangeTwitterCode(code: string, codeVerifier: string): Promise<TwitterTokenResponse> {
  const basicAuth = Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString("base64");

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: TWITTER_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  const data = (await res.json()) as TwitterTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(data.error_description || "Twitter token exchange failed");
  }
  return data;
}

export async function getTwitterUser(accessToken: string): Promise<{
  id: string;
  username: string;
  name: string;
  avatar_url: string | null;
  follower_count: number;
}> {
  const res = await fetch(
    "https://api.twitter.com/2/users/me?user.fields=public_metrics,profile_image_url",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const data = (await res.json()) as TwitterUserResponse;
  if (!res.ok || data.errors) {
    throw new Error(data.errors?.[0]?.message || "Failed to fetch Twitter user");
  }

  return {
    id: data.data.id,
    username: data.data.username,
    name: data.data.name,
    avatar_url: data.data.profile_image_url ?? null,
    follower_count: data.data.public_metrics?.followers_count ?? 0,
  };
}
