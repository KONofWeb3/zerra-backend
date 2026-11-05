import { supabase } from "../supabase";
import { getProvider } from "./providers";
import {
  ALGO_VERSION, STRONG_THRESHOLD, followerQuality, median, scoreReadiness,
} from "./score";
import { nicheVoices } from "./niches";
import type { PostLite } from "./types";

const SAMPLE_SIZE = 400; // two pages of 200: keeps a refresh to a handful of rate-limited calls
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 60;   // 30 recent days + the 30 before, for the engagement trend
const MIN_TREND_POSTS = 3;

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

const SNAPSHOT_COLUMNS =
  "snapshot_date, followers_total, sampled, quality_followers, seed_followers, posts_30d, engagement_per_post, score, tier, created_at, algo_version, components, metrics, niches";

export async function getSnapshots(userId: string, days = 30) {
  const { data, error } = await supabase
    .from("readiness_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("user_id", userId)
    .order("snapshot_date", { ascending: false })
    .limit(days);
  if (error) throw new Error(error.message);
  return data ?? [];
}

const erOf = (p: PostLite) => (p.views > 0 ? (p.likes + p.replies + p.retweets + p.quotes) / p.views : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Zerra creators we already know: a sampled follower who is a connected Zerra
 * user with a readiness score counts for more than their raw stats say. This is
 * the cross-check against our own database that saves guessing from X data
 * alone, and it gets better as more creators join.
 */
async function knownCreatorScores(handles: string[]): Promise<Map<string, number>> {
  if (handles.length === 0) return new Map();
  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("user_id, username")
    .eq("platform", "twitter");
  const wanted = new Set(handles);
  const idByHandle = new Map<string, string>();
  for (const a of accounts ?? []) {
    const h = String(a.username ?? "").toLowerCase();
    if (h && wanted.has(h)) idByHandle.set(h, a.user_id);
  }
  if (idByHandle.size === 0) return new Map();

  const { data: snaps } = await supabase
    .from("readiness_snapshots")
    .select("user_id, score, snapshot_date")
    .in("user_id", [...idByHandle.values()])
    .order("snapshot_date", { ascending: false });
  const latest = new Map<string, number>();
  for (const s of snaps ?? []) if (!latest.has(s.user_id)) latest.set(s.user_id, Number(s.score));

  const out = new Map<string, number>();
  for (const [h, uid] of idByHandle) if (latest.has(uid)) out.set(h, latest.get(uid)!);
  return out;
}

export async function computeAndStoreReadiness(userId: string) {
  const provider = getProvider();
  if (!provider) throw new ReadinessError("unavailable", "No readiness data source is configured");

  const account = await getTwitterAccount(userId);
  if (!account?.username) throw new ReadinessError("not_connected", "No connected X account");

  const { data: seedRows } = await supabase.from("seed_accounts").select("handle");
  const seeds = new Set((seedRows ?? []).map((r: { handle: string }) => r.handle));

  const now = Date.now();
  let sample, recent;
  try {
    // One after the other: the data provider allows very few requests per second.
    sample = await provider.getFollowerSample(account.username, SAMPLE_SIZE);
    recent = await provider.getRecentPosts(account.username, now - WINDOW_DAYS * DAY_MS);
  } catch (err: any) {
    throw new ReadinessError("provider_failed", err.message);
  }

  const total = Math.max(recent.followers ?? account.follower_count ?? 0, sample.length);
  if (recent.followers && recent.followers !== account.follower_count) {
    await supabase.from("social_accounts").update({ follower_count: recent.followers })
      .eq("user_id", userId).eq("platform", "twitter");
  }

  // ── Audience quality ──
  const known = await knownCreatorScores(sample.map((f) => f.username));
  const qualities = sample.map((f) => {
    if (seeds.has(f.username)) return 100;
    const q = followerQuality(f, now);
    const z = known.get(f.username);
    return z != null ? Math.max(q, 40 + z * 0.6) : q;
  });
  const seedHits = sample.filter((f) => seeds.has(f.username)).length;
  const meanQ = mean(qualities) ?? 0;
  const strongShare = sample.length ? qualities.filter((q) => q >= STRONG_THRESHOLD).length / sample.length : 0;
  const seedShare = sample.length ? seedHits / sample.length : 0;

  // ── The creator's own posting ──
  const posts = recent.posts;
  const recent30 = posts.filter((p) => now - new Date(p.createdAt).getTime() <= 30 * DAY_MS);
  const prior30 = posts.filter((p) => {
    const age = now - new Date(p.createdAt).getTime();
    return age > 30 * DAY_MS && age <= 60 * DAY_MS;
  });
  const newest = posts.reduce<number | null>((n, p) => {
    const t = new Date(p.createdAt).getTime();
    return n == null || t > n ? t : n;
  }, null);
  const daysSinceLastPost = newest == null ? null : Math.max(0, Math.floor((now - newest) / DAY_MS));

  const erRecent = recent30.map(erOf).filter((x): x is number => x != null);
  const erPrior = prior30.map(erOf).filter((x): x is number => x != null);
  // With nothing recent, judge engagement on the older posts: activity and the inactivity gate carry the penalty.
  const erPool = erRecent.length ? erRecent : erPrior;
  const erViews = median(erPool);
  const medViews = median((recent30.length ? recent30 : prior30).map((p) => p.views).filter((v) => v > 0));
  const viewsPerFollower = medViews != null && total > 0 ? medViews / total : null;

  let erTrend: number | null = null;
  if (erRecent.length >= MIN_TREND_POSTS && erPrior.length >= MIN_TREND_POSTS) {
    const r = mean(erRecent)!, p = mean(erPrior)!;
    if (p > 0) erTrend = (r - p) / p;
  } else if (erRecent.length === 0 && erPrior.length >= MIN_TREND_POSTS) {
    erTrend = -1; // was active, now silent
  }

  // ── Follower growth from our own history ──
  let followerGrowth: number | null = null;
  const history = await getSnapshots(userId, 45);
  const old = [...history].reverse().find((s) => now - new Date(s.created_at).getTime() >= 7 * DAY_MS);
  if (old && old.followers_total > 0) {
    const ageDays = (now - new Date(old.created_at).getTime()) / DAY_MS;
    followerGrowth = ((total - old.followers_total) / old.followers_total) * (30 / ageDays);
  }

  const result = scoreReadiness({
    followers: total,
    meanFollowerQuality: meanQ,
    strongShare,
    seedShare,
    posts30: recent30.length,
    daysSinceLastPost,
    erViews,
    viewsPerFollower,
    erTrend,
    followerGrowth,
  });

  const voices = nicheVoices(posts);

  const row = {
    user_id: userId,
    snapshot_date: new Date().toISOString().slice(0, 10),
    followers_total: total,
    sampled: sample.length,
    quality_followers: Math.round(strongShare * total),
    seed_followers: seedHits,
    posts_30d: recent30.length,
    engagement_per_post: null,
    score: result.score,
    tier: result.tier,
    algo_version: ALGO_VERSION,
    components: result.components,
    metrics: {
      followers: total,
      meanFollowerQuality: Math.round(meanQ * 10) / 10,
      strongShare: Math.round(strongShare * 1000) / 1000,
      knownCreators: known.size,
      posts30: recent30.length,
      posts60: posts.length,
      daysSinceLastPost,
      erViews,
      viewsPerFollower,
      erTrend,
      followerGrowth,
      gate: result.gate,
    },
    niches: voices,
  };
  const { error } = await supabase.from("readiness_snapshots").upsert(row, { onConflict: "user_id,snapshot_date" });
  if (error) throw new Error(error.message);
  return row;
}

export interface Voice {
  niche: string;
  score: number;
  label: string;
  posts: number;
  rank: number;
  cohort: number;
  /** Only once enough creators share the niche for a percentile to mean something. */
  top_percent: number | null;
}

const MIN_COHORT_FOR_PERCENT = 20;

/** Rank this user's strongest niches against every Zerra creator's latest snapshot. */
export async function voicesWithRank(userId: string, niches: { niche: string; score: number; label: string; posts: number }[] | null): Promise<Voice[]> {
  if (!niches?.length) return [];
  const since = new Date(Date.now() - 10 * DAY_MS).toISOString().slice(0, 10);
  const { data } = await supabase
    .from("readiness_snapshots")
    .select("user_id, niches, snapshot_date")
    .gte("snapshot_date", since)
    .order("snapshot_date", { ascending: false });

  const latestByUser = new Map<string, { niche: string; score: number }[]>();
  for (const r of data ?? []) if (!latestByUser.has(r.user_id)) latestByUser.set(r.user_id, (r.niches as any[]) ?? []);

  return niches.map((n) => {
    const scores: number[] = [];
    for (const [uid, list] of latestByUser) {
      if (uid === userId) continue;
      const hit = list.find((x) => x.niche === n.niche);
      if (hit) scores.push(hit.score);
    }
    const cohort = scores.length + 1;
    const rank = scores.filter((s) => s > n.score).length + 1;
    return {
      ...n,
      rank,
      cohort,
      top_percent: cohort >= MIN_COHORT_FOR_PERCENT ? Math.max(1, Math.ceil((rank / cohort) * 100)) : null,
    };
  });
}
