// CT discovery: turns the last 30 days of collected posts into one ranked row per account.
//
// Scored today (60 of the 100 points): reach 25, engagement quality 20, niche relevance 10,
// authenticity 5. Recognition by credible CT accounts (25) and network quality (15) need follower
// and engager identities we don't collect yet, so they score 0 and are reported as unavailable
// (coverage 60%). Medians drive everything, and views are public views, never "impressions".

import { supabase } from "../supabase";
import { classifyPost } from "./niches";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PostRow {
  handle: string; name: string | null; avatar: string | null; followers: number | null; author_id: string | null;
  views: number; likes: number; replies: number; retweets: number; quotes: number;
  kind: string; posted_at: string; text: string; keywords: string[] | null;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Share of `pool` that is below x (0..1). */
function percentile(pool: number[], x: number): number {
  if (pool.length <= 1) return 0.5;
  let below = 0;
  for (const v of pool) if (v < x) below++;
  return below / (pool.length - 1);
}

function bucket<T>(m: Map<string, T[]>, key: string): T[] {
  let list = m.get(key);
  if (!list) { list = []; m.set(key, list); }
  return list;
}

export async function computeDiscovery(): Promise<number> {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const posts: PostRow[] = [];
  for (let from = 0; from < 100000; from += 1000) { // the database returns at most 1,000 rows per request
    const { data, error } = await supabase
      .from("ct_posts")
      .select("handle, name, avatar, followers, author_id, views, likes, replies, retweets, quotes, kind, posted_at, text, keywords")
      .gte("posted_at", since)
      .order("posted_at", { ascending: false })
      .range(from, from + 999);
    if (error) { console.error("CT discovery: reading posts failed:", error.message); return 0; }
    posts.push(...((data ?? []) as PostRow[]));
    if (!data || data.length < 1000) break;
  }

  const byHandle = new Map<string, PostRow[]>();
  for (const p of posts) {
    const h = String(p.handle ?? "").toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(h)) continue;
    bucket(byHandle, h).push(p);
  }

  interface Acc {
    handle: string; authorId: string | null; name: string | null; avatar: string | null; followers: number;
    originals: number; quotes: number; days: number; medViews: number; avgViews: number; medEr: number | null;
    medLikes: number; medReplies: number; medReposts: number; medQuotes: number;
    primary: string | null; secondary: string | null; primaryShare: number;
    sources: Record<string, number>; lastPostAt: string; maxEr: number;
  }
  const accs: Acc[] = [];
  for (const [handle, ps] of byHandle) {
    const views = ps.map((p) => Number(p.views) || 0);
    const ers = ps
      .filter((p) => Number(p.views) > 0)
      .map((p) => ((Number(p.likes) + Number(p.replies) + Number(p.retweets) + Number(p.quotes)) / Number(p.views)) * 100);
    const nicheCount = new Map<string, number>();
    for (const p of ps) for (const n of classifyPost(p.text ?? "")) nicheCount.set(n, (nicheCount.get(n) ?? 0) + 1);
    const ranked = [...nicheCount.entries()].sort((a, b) => b[1] - a[1]);
    const sources: Record<string, number> = {};
    for (const p of ps) for (const k of p.keywords ?? []) sources[k] = (sources[k] ?? 0) + 1;
    accs.push({
      handle,
      authorId: ps.find((p) => p.author_id)?.author_id ?? null,
      name: ps.find((p) => p.name)?.name ?? null,
      avatar: ps.find((p) => p.avatar)?.avatar ?? null,
      followers: Math.max(0, ...ps.map((p) => Number(p.followers) || 0)),
      originals: ps.filter((p) => p.kind !== "quote").length,
      quotes: ps.filter((p) => p.kind === "quote").length,
      days: new Set(ps.map((p) => String(p.posted_at).slice(0, 10))).size,
      medViews: median(views),
      avgViews: views.reduce((a, b) => a + b, 0) / views.length,
      medEr: ers.length ? median(ers) : null,
      medLikes: median(ps.map((p) => Number(p.likes) || 0)),
      medReplies: median(ps.map((p) => Number(p.replies) || 0)),
      medReposts: median(ps.map((p) => Number(p.retweets) || 0)),
      medQuotes: median(ps.map((p) => Number(p.quotes) || 0)),
      primary: ranked[0]?.[0] ?? null,
      secondary: ranked[1]?.[0] ?? null,
      primaryShare: ranked.length ? ranked[0][1] / ps.length : 0,
      sources,
      lastPostAt: ps.reduce((m, p) => (p.posted_at > m ? p.posted_at : m), ps[0].posted_at),
      maxEr: ers.length ? Math.max(...ers) : 0,
    });
  }

  // Percentiles inside the account's niche when the niche has enough accounts, otherwise across everyone.
  const cohortViews = new Map<string, number[]>();
  const cohortEr = new Map<string, number[]>();
  for (const a of accs) {
    if (!a.primary) continue;
    bucket(cohortViews, a.primary).push(a.medViews);
    if (a.medEr !== null) bucket(cohortEr, a.primary).push(a.medEr);
  }
  const allViews = accs.map((a) => a.medViews);
  const allEr = accs.flatMap((a) => (a.medEr === null ? [] : [a.medEr]));
  const pool = (m: Map<string, number[]>, niche: string | null, all: number[]) => {
    const c = niche ? m.get(niche) : undefined;
    return c && c.length >= 20 ? c : all;
  };

  const { data: existing } = await supabase.from("ct_accounts").select("handle, status");
  const prevStatus = new Map<string, string>((existing ?? []).map((r: any) => [r.handle as string, r.status as string]));
  const HUMAN = new Set(["approved", "rejected", "under_review"]);

  const now = new Date().toISOString();
  const rows = accs.map((a) => {
    const pctViews = percentile(pool(cohortViews, a.primary, allViews), a.medViews);
    const pctEr = a.medEr === null ? 0 : percentile(pool(cohortEr, a.primary, allEr), a.medEr);
    const reach = 25 * (0.7 * pctViews + 0.3 * Math.min(1, a.days / 12));
    const engagement = a.medEr === null ? 0 : 20 * (0.7 * pctEr + 0.3 * Math.min(1, a.originals / 6));
    const niche = 10 * a.primaryShare * Math.min(1, (a.originals + a.quotes) / 3);

    // Authenticity: an unrealistic engagement rate, or views far beyond the audience, are red flags.
    const flags = (a.maxEr > 30 && a.medViews > 5000 ? 1 : 0) + (a.followers > 0 && a.medViews / a.followers > 100 ? 1 : 0);
    const authenticity = flags >= 1 ? "Low" : a.days >= 5 && a.originals >= 5 && a.followers > 0 ? "High" : "Medium";
    const authPoints = authenticity === "High" ? 5 : authenticity === "Medium" ? 3 : 0;
    const dataConfidence = a.days >= 8 && a.originals + a.quotes >= 8 ? "High" : a.days >= 3 ? "Medium" : "Low";

    const score = round1(reach + engagement + niche + authPoints);
    const prev = prevStatus.get(a.handle);
    const emerging = a.followers > 0 && a.followers < 25000 && a.days >= 3 && a.originals >= 3 && pctEr >= 0.7;
    const status = prev && HUMAN.has(prev) ? prev : emerging ? "emerging" : "discovered";
    return {
      handle: a.handle, author_id: a.authorId, name: a.name, avatar: a.avatar, followers: a.followers,
      status, niche_primary: a.primary, niche_secondary: a.secondary,
      originals: a.originals, quotes: a.quotes, active_days: a.days,
      median_views: Math.round(a.medViews), avg_views: Math.round(a.avgViews),
      median_er: a.medEr === null ? null : Math.round(a.medEr * 100) / 100,
      median_likes: a.medLikes, median_replies: a.medReplies, median_reposts: a.medReposts, median_quotes: a.medQuotes,
      discovery_score: score,
      score_parts: { reach: round1(reach), engagement: round1(engagement), recognition: null, network: null, niche: round1(niche), authenticity: authPoints },
      coverage: 0.6, authenticity, data_confidence: dataConfidence, sources: a.sources,
      last_post_at: a.lastPostAt, updated_at: now,
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from("ct_accounts").upsert(rows.slice(i, i + 500), { onConflict: "handle" });
    if (error) { console.error("CT discovery: saving accounts failed:", error.message); return 0; }
  }

  // One snapshot per account per day, for the audit trail.
  const day = now.slice(0, 10);
  const snaps = rows.map((r) => ({
    handle: r.handle, day, discovery_score: r.discovery_score,
    metrics: { followers: r.followers, active_days: r.active_days, median_views: r.median_views, median_er: r.median_er, originals: r.originals, quotes: r.quotes },
  }));
  for (let i = 0; i < snaps.length; i += 500) {
    const { error } = await supabase.from("ct_account_snapshots").upsert(snaps.slice(i, i + 500), { onConflict: "handle,day" });
    if (error) { console.error("CT discovery: saving snapshots failed:", error.message); break; }
  }
  console.log(`CT discovery: scored ${rows.length} accounts`);
  return rows.length;
}
