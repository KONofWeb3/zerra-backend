// Reads a creator's X account and records what they posted, so weekly task plans can be checked
// automatically: replies, threads, articles and posts, each by the creator's local day.

import { supabase } from "./supabase";
import { getProvider } from "./readiness/providers";
import { getTwitterAccount } from "./readiness/service";
import type { ActivityTweet } from "./readiness/types";

const DAY_MS = 86_400_000;
const STALE_MS = 20 * 60 * 1000;
const running = new Map<string, Promise<void>>();
const attempted = new Map<string, number>(); // so a failing sync isn't retried on every page load

export type ActivityKind = "reply" | "thread" | "article" | "post";

/** The creator's local calendar day for a moment in time (offset is JS getTimezoneOffset()). */
export const localDay = (ms: number, tzOffsetMin: number) => new Date(ms - tzOffsetMin * 60_000).toISOString().slice(0, 10);

/** Turn a list of the account's own tweets into countable activity. */
export function classify(tweets: ActivityTweet[], username: string, tzOffsetMin: number) {
  const me = username.toLowerCase();
  const own = new Map(tweets.map((t) => [t.id, t]));
  const rows: { tweet_id: string; kind: ActivityKind; day: string; posted_at: string }[] = [];
  const seen = new Set<string>();
  const add = (t: ActivityTweet, kind: ActivityKind) => {
    const key = `${t.id}:${kind}`;
    const at = new Date(t.createdAt).getTime();
    if (seen.has(key) || Number.isNaN(at)) return;
    seen.add(key);
    rows.push({ tweet_id: t.id, kind, day: localDay(at, tzOffsetMin), posted_at: new Date(at).toISOString() });
  };
  const isSelfReply = (t: ActivityTweet) =>
    t.isReply && ((t.inReplyToUsername ?? "").toLowerCase() === me || (t.inReplyToId != null && own.has(t.inReplyToId)));

  for (const t of tweets) {
    if (t.isRetweet) continue;
    if (!t.isReply) {
      add(t, "post");
      if (t.isArticle) add(t, "article");
    } else if (isSelfReply(t)) {
      // A reply to yourself continues a thread: the thread counts once, on the day its first post went out.
      let root: ActivityTweet | undefined = t;
      for (let i = 0; i < 50 && root && isSelfReply(root); i++) root = root.inReplyToId ? own.get(root.inReplyToId) : undefined;
      if (root && !root.isReply) add(root, "thread");
    } else {
      add(t, "reply");
    }
  }
  return rows;
}

async function doSync(userId: string, tzOffsetMin: number) {
  const provider = getProvider();
  if (!provider) return;
  const account = await getTwitterAccount(userId);
  if (!account?.username) return;

  const { data: plans } = await supabase.from("task_plans").select("id, start_date").eq("user_id", userId).is("archived_at", null);
  if (!plans || plans.length === 0) return;
  const earliest = Math.min(...plans.map((p: any) => Date.parse(`${p.start_date}T00:00:00Z`)));
  const sinceMs = Math.max(earliest - 2 * DAY_MS, Date.now() - 120 * DAY_MS);

  const tweets = await provider.getActivity(account.username, sinceMs);
  const rows = classify(tweets, account.username, tzOffsetMin).map((r) => ({ user_id: userId, ...r }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from("x_activity").upsert(rows.slice(i, i + 500), { onConflict: "user_id,tweet_id,kind" });
    if (error) { console.error("task sync: saving activity failed:", error.message); return; }
  }
  await supabase.from("task_plans").update({ last_synced_at: new Date().toISOString() }).eq("user_id", userId).is("archived_at", null);
}

export function isSyncing(userId: string) {
  return running.has(userId);
}

/** Start a sync in the background unless the plans were synced recently (or one is already running). */
export function syncIfStale(userId: string, tzOffsetMin: number, lastSyncedAt: (string | null)[]) {
  if (running.has(userId)) return;
  if (Date.now() - (attempted.get(userId) ?? 0) < 5 * 60 * 1000) return;
  const newest = Math.max(0, ...lastSyncedAt.map((s) => (s ? Date.parse(s) : 0)));
  if (Date.now() - newest < STALE_MS) return;
  attempted.set(userId, Date.now());
  const p = doSync(userId, tzOffsetMin)
    .catch((err: any) => console.error("task sync failed:", err.message))
    .finally(() => running.delete(userId));
  running.set(userId, p);
}
