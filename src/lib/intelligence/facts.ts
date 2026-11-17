// Creator Intelligence, step 1: calculate the facts.
//
// Everything numeric in a report is computed here, from the creator's own stored posts and their latest
// Smart Readiness snapshot. The language model only interprets these facts; it never gets to invent numbers.

import { supabase } from "../supabase";
import { classifyPost } from "../readiness/niches";
import { median } from "../readiness/score";
import type { AudienceBreakdown } from "./audience";

const DAY_MS = 86_400_000;
const MIN_GROUP = 3; // a pattern needs at least this many posts before we call it a pattern
export const MIN_POSTS_FOR_REPORT = 8;

interface PostRow {
  post_id: string; text: string; posted_at: string;
  likes: number; replies: number; retweets: number; quotes: number; views: number;
}

const er = (p: PostRow): number | null =>
  p.views > 0 ? ((p.likes + p.replies + p.retweets + p.quotes) / p.views) * 100 : null;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const medOrNull = (xs: number[]) => { const m = median(xs); return m == null ? null : r2(m); };

export interface CreatorFacts {
  handle: string;
  generated_at: string;
  window_days: number;
  posts_analyzed: number;
  account: {
    followers: number | null;
    readiness_score: number | null;
    follower_quality: number | null;
    strong_follower_share: number | null;
    median_engagement_rate_pct: number | null;
    engagement_trend: number | null;
    follower_growth_30d: number | null;
    posts_last_30d: number | null;
    days_since_last_post: number | null;
  };
  audience: AudienceBreakdown | null;
  cadence: { posts_per_week_30d: number; longest_gap_days: number };
  topics: {
    top_topic: string | null;
    top_topic_share_pct: number;
    topics_with_10pct_or_more: number;
    no_clear_topic_share_pct: number;
    by_topic: { topic: string; posts: number; share_pct: number; median_engagement_rate_pct: number | null; median_views: number | null }[];
  };
  formats: { format: string; posts: number; median_engagement_rate_pct: number | null }[];
  weekdays_utc: { day: string; posts: number; median_engagement_rate_pct: number | null }[];
  best_posts: { text: string; views: number; engagement_rate_pct: number | null; posted_at: string; topics: string[] }[];
  weakest_posts: { text: string; views: number; engagement_rate_pct: number | null; posted_at: string; topics: string[] }[];
}

const snippet = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 220);

export async function buildFacts(userId: string, handle: string): Promise<CreatorFacts | null> {
  const since = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const { data: rows } = await supabase
    .from("x_posts")
    .select("post_id, text, posted_at, likes, replies, retweets, quotes, views")
    .eq("user_id", userId)
    .gte("posted_at", since)
    .order("posted_at", { ascending: false })
    .limit(300);
  const posts = (rows ?? []) as PostRow[];
  if (posts.length < MIN_POSTS_FOR_REPORT) return null;

  const { data: snap } = await supabase
    .from("readiness_snapshots")
    .select("score, followers_total, metrics")
    .eq("user_id", userId)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const m: any = snap?.metrics ?? {};

  // ── topics ──
  const withTopics = posts.map((p) => ({ p, topics: classifyPost(p.text) }));
  const byTopic = new Map<string, PostRow[]>();
  for (const { p, topics } of withTopics) for (const t of topics) (byTopic.get(t) ?? byTopic.set(t, []).get(t)!).push(p);
  const topicRows = [...byTopic.entries()]
    .map(([topic, ps]) => ({
      topic,
      posts: ps.length,
      share_pct: r1((ps.length / posts.length) * 100),
      median_engagement_rate_pct: ps.length >= MIN_GROUP ? medOrNull(ps.map(er).filter((x): x is number => x != null)) : null,
      median_views: ps.length >= MIN_GROUP ? medOrNull(ps.map((p) => p.views)) : null,
    }))
    .sort((a, b) => b.posts - a.posts);
  const noTopic = withTopics.filter((x) => x.topics.length === 0).length;

  // ── formats ──
  const groups: { format: string; test: (p: PostRow) => boolean }[] = [
    { format: "Short posts (under 120 characters)", test: (p) => p.text.length < 120 },
    { format: "Medium posts (120 to 240 characters)", test: (p) => p.text.length >= 120 && p.text.length <= 240 },
    { format: "Long posts (over 240 characters)", test: (p) => p.text.length > 240 },
    { format: "Posts with a link", test: (p) => /https?:\/\//i.test(p.text) },
    { format: "Posts without a link", test: (p) => !/https?:\/\//i.test(p.text) },
    { format: "Posts that ask a question", test: (p) => p.text.includes("?") },
  ];
  const formats = groups
    .map((g) => {
      const ps = posts.filter(g.test);
      return { format: g.format, posts: ps.length, median_engagement_rate_pct: medOrNull(ps.map(er).filter((x): x is number => x != null)) };
    })
    .filter((g) => g.posts >= MIN_GROUP);

  // ── weekdays (UTC) ──
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekdays = DAYS.map((day, i) => {
    const ps = posts.filter((p) => new Date(p.posted_at).getUTCDay() === i);
    return { day, posts: ps.length, median_engagement_rate_pct: medOrNull(ps.map(er).filter((x): x is number => x != null)) };
  }).filter((d) => d.posts >= MIN_GROUP);

  // ── cadence ──
  const times = posts.map((p) => new Date(p.posted_at).getTime()).sort((a, b) => a - b);
  let longestGap = 0;
  for (let i = 1; i < times.length; i++) longestGap = Math.max(longestGap, (times[i] - times[i - 1]) / DAY_MS);
  longestGap = Math.max(longestGap, (Date.now() - times[times.length - 1]) / DAY_MS);
  const last30 = posts.filter((p) => Date.now() - new Date(p.posted_at).getTime() <= 30 * DAY_MS).length;

  // ── best and weakest posts (by engagement rate, among posts with enough views to mean something) ──
  const rated = withTopics
    .map(({ p, topics }) => ({ p, topics, e: er(p) }))
    .filter((x): x is { p: PostRow; topics: string[]; e: number } => x.e != null && x.p.views >= 100);
  const show = (x: { p: PostRow; topics: string[]; e: number }) => ({
    text: snippet(x.p.text), views: x.p.views, engagement_rate_pct: r2(x.e), posted_at: x.p.posted_at.slice(0, 10), topics: x.topics,
  });
  const sortedByEr = [...rated].sort((a, b) => b.e - a.e);
  const best = sortedByEr.slice(0, 5).map(show);
  const weakest = sortedByEr.length > 8 ? sortedByEr.slice(-3).reverse().map(show) : [];

  return {
    handle,
    generated_at: new Date().toISOString(),
    window_days: 60,
    posts_analyzed: posts.length,
    account: {
      followers: snap?.followers_total ?? null,
      readiness_score: snap?.score ?? null,
      follower_quality: m.meanFollowerQuality ?? null,
      strong_follower_share: m.strongShare != null ? r1(m.strongShare * 100) : null,
      median_engagement_rate_pct: m.erViews != null ? r2(m.erViews * 100) : null,
      engagement_trend: m.erTrend != null ? r2(m.erTrend) : null,
      follower_growth_30d: m.followerGrowth != null ? r2(m.followerGrowth) : null,
      posts_last_30d: m.posts30 ?? last30,
      days_since_last_post: m.daysSinceLastPost ?? null,
    },
    audience: (m.audience as AudienceBreakdown | undefined) ?? null,
    cadence: { posts_per_week_30d: r1((last30 / 30) * 7), longest_gap_days: r1(longestGap) },
    topics: {
      top_topic: topicRows[0]?.topic ?? null,
      top_topic_share_pct: topicRows[0]?.share_pct ?? 0,
      topics_with_10pct_or_more: topicRows.filter((t) => t.share_pct >= 10).length,
      no_clear_topic_share_pct: r1((noTopic / posts.length) * 100),
      by_topic: topicRows.slice(0, 8),
    },
    formats,
    weekdays_utc: weekdays,
    best_posts: best,
    weakest_posts: weakest,
  };
}
