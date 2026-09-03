// src/lib/analyticsInsights.ts
//
// Computes the "Zerra Insight" and "Where Your Influence Fit" cards, plus
// the Performance card's Best Platform/Format/Time rows, for the Analytics
// Overview tab. Everything here is derived from real synced data — a
// result is `null` whenever there isn't enough signal yet, never a
// plausible-looking placeholder.

import { supabase } from "./supabase";
import { classifyPostContent, classifyCampaignTopic, type Topic } from "./ai/classifyContent";

interface ClassifiedPost {
  post_id: string;
  title: string | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  engagement_rate: number;
  created_time: string | null;
  topic: Topic | null;
  style: string | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Reads a creator's tiktok_posts, lazily classifying (and caching) any post missing a topic/style. */
export async function getClassifiedPosts(userId: string): Promise<ClassifiedPost[]> {
  const { data: posts } = await supabase
    .from("tiktok_posts")
    .select("post_id, title, view_count, like_count, comment_count, share_count, engagement_rate, created_time, topic, style")
    .eq("user_id", userId);

  const rows = (posts ?? []) as ClassifiedPost[];
  const unclassified = rows.filter((p) => !p.topic);

  for (const batch of chunk(unclassified, 5)) {
    await Promise.all(batch.map(async (p) => {
      const { topic, style } = await classifyPostContent(p.title ?? "", "");
      p.topic = topic;
      p.style = style;
      await supabase.from("tiktok_posts").update({ topic, style }).eq("user_id", userId).eq("post_id", p.post_id);
    }));
  }

  return rows;
}

interface BestTopic {
  topic: Topic;
  avgEngagement: number;
  multiplier: number;
  topPost: ClassifiedPost;
}

/** The creator's single best-performing topic, requiring at least 2 posts so one video can't look like a trend. "Other" is excluded — it's a catch-all, not a real signal to headline. */
function computeBestTopic(posts: ClassifiedPost[]): BestTopic | null {
  const overallAvg = posts.length > 0
    ? posts.reduce((s, p) => s + Number(p.engagement_rate || 0), 0) / posts.length
    : 0;
  if (overallAvg <= 0) return null;

  const byTopic = new Map<Topic, ClassifiedPost[]>();
  for (const p of posts) {
    if (!p.topic || p.topic === "Other") continue;
    const list = byTopic.get(p.topic) ?? [];
    list.push(p);
    byTopic.set(p.topic, list);
  }

  let best: BestTopic | null = null;
  for (const [topic, list] of byTopic) {
    if (list.length < 2) continue;
    const avgEngagement = list.reduce((s, p) => s + Number(p.engagement_rate || 0), 0) / list.length;
    if (avgEngagement <= overallAvg) continue;
    const multiplier = Math.round((avgEngagement / overallAvg) * 10) / 10;
    if (!best || avgEngagement > best.avgEngagement) {
      const topPost = [...list].sort((a, b) => Number(b.engagement_rate) - Number(a.engagement_rate))[0];
      best = { topic, avgEngagement, multiplier, topPost };
    }
  }

  return best;
}

export function computePerformanceInsight(posts: ClassifiedPost[]): { headline: string; recommendation: string } | null {
  const best = computeBestTopic(posts);
  if (!best) return null;

  return {
    headline: `Your ${best.topic} content is performing ${best.multiplier}x better than your average`,
    recommendation: `Your audience engages most with ${best.topPost.style ?? "Storytelling/Vlog"}`,
  };
}

export async function computeInfluenceFit(posts: ClassifiedPost[]): Promise<{ campaignName: string; why: string } | null> {
  const best = computeBestTopic(posts);
  if (!best) return null;

  const { data: campaigns } = await supabase
    .from("bounties")
    .select("id, project_name, description, required_hashtags, topic")
    .eq("status", "active");

  const list = (campaigns ?? []) as { id: string; project_name: string; description: string | null; required_hashtags: string[] | null; topic: Topic | null }[];
  const unclassified = list.filter((c) => !c.topic);

  for (const batch of chunk(unclassified, 5)) {
    await Promise.all(batch.map(async (c) => {
      const topic = await classifyCampaignTopic(c);
      c.topic = topic;
      await supabase.from("bounties").update({ topic }).eq("id", c.id);
    }));
  }

  const match = list.find((c) => c.topic === best.topic);
  if (!match) return null;

  return {
    campaignName: match.project_name,
    why: `${best.multiplier}x higher engagement on ${best.topic} content + strong audience relevance`,
  };
}

function formatHour12(h: number): { label: string; period: "AM" | "PM" } {
  const period = h >= 12 ? "PM" : "AM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { label: String(hour12), period };
}

/** Best 2-hour posting window by summed views, bucketed by UTC hour-of-day.
 *  Known limitation: not creator-timezone-aware. Returns null until at least
 *  3 posts have a real created_time (i.e. synced since this field was added). */
export function computeBestTimeWindow(posts: ClassifiedPost[]): string | null {
  const withTime = posts.filter((p) => p.created_time);
  if (withTime.length < 3) return null;

  const hourViews = new Array(24).fill(0);
  for (const p of withTime) {
    const hour = new Date(p.created_time as string).getUTCHours();
    hourViews[hour] += Number(p.view_count) || 0;
  }

  let bestStart = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const sum = hourViews[h] + hourViews[(h + 1) % 24];
    if (sum > bestSum) { bestSum = sum; bestStart = h; }
  }

  const start = formatHour12(bestStart);
  const end = formatHour12((bestStart + 2) % 24);
  return `${start.label}–${end.label} ${end.period}`;
}
