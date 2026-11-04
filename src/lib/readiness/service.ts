import { supabase } from "../supabase";
import { getProvider } from "./providers";
import { followerQuality, readinessScore, QUALITY_THRESHOLD } from "./score";

const SAMPLE_SIZE = 400; // two pages of 200: keeps a refresh to a handful of rate-limited calls
const THIRTY_DAYS_MS = 30 * 86_400_000;

export class ReadinessError extends Error {
  constructor(public code: "unavailable" | "not_connected" | "provider_failed", message: string) {
    super(message);
  }
}

export async function getTwitterAccount(userId: string) {
  const { data } = await supabase
    .from("social_accounts")
    .select("username, follower_count")
    .eq("user_id", userId)
    .eq("platform", "twitter")
    .maybeSingle();
  return data as { username: string | null; follower_count: number | null } | null;
}

export async function computeAndStoreReadiness(userId: string) {
  const provider = getProvider();
  if (!provider) throw new ReadinessError("unavailable", "No readiness data source is configured");

  const account = await getTwitterAccount(userId);
  if (!account?.username) throw new ReadinessError("not_connected", "No connected X account");

  const { data: seedRows } = await supabase.from("seed_accounts").select("handle");
  const seeds = new Set((seedRows ?? []).map((r: { handle: string }) => r.handle));

  let sample, posts;
  try {
    // One after the other: the data provider allows very few requests per second.
    sample = await provider.getFollowerSample(account.username, SAMPLE_SIZE);
    posts = await provider.getRecentPosts(account.username, Date.now() - THIRTY_DAYS_MS);
  } catch (err: any) {
    throw new ReadinessError("provider_failed", err.message);
  }

  const total = Math.max(account.follower_count ?? 0, sample.length);
  const seedHits = sample.filter((f) => seeds.has(f.username)).length;
  const quality = sample.filter((f) => seeds.has(f.username) || followerQuality(f) >= QUALITY_THRESHOLD).length;
  // The sample is the newest followers, so scale its quality rate up to the full count as an estimate.
  const qualityFollowers = sample.length ? Math.round((quality / sample.length) * total) : 0;

  const engagementPerPost = null; // no provider endpoint for distinct high-quality engagers yet
  const { score, tier } = readinessScore({ qualityFollowers, engagementPerPost, posts: posts.length });

  const row = {
    user_id: userId,
    snapshot_date: new Date().toISOString().slice(0, 10),
    followers_total: total,
    sampled: sample.length,
    quality_followers: qualityFollowers,
    seed_followers: seedHits,
    posts_30d: posts.length,
    engagement_per_post: engagementPerPost,
    score,
    tier,
  };
  const { error } = await supabase.from("readiness_snapshots").upsert(row, { onConflict: "user_id,snapshot_date" });
  if (error) throw new Error(error.message);
  return row;
}

export async function getSnapshots(userId: string, days = 30) {
  const { data, error } = await supabase
    .from("readiness_snapshots")
    .select("snapshot_date, followers_total, sampled, quality_followers, seed_followers, posts_30d, engagement_per_post, score, tier, created_at")
    .eq("user_id", userId)
    .order("snapshot_date", { ascending: false })
    .limit(days);
  if (error) throw new Error(error.message);
  return data ?? [];
}
