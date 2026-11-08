// Daily Smart Readiness snapshot for every user with a connected X account.
// Same in-process polling pattern as influenceScoreWorker.ts. Does nothing
// unless a data provider is configured (TWITTERAPI_IO_KEY).

import { supabase } from "../lib/supabase";
import { getProvider } from "../lib/readiness/providers";
import { computeAndStoreReadiness } from "../lib/readiness/service";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 25;
const STALE_AFTER_MS = 23 * 60 * 60 * 1000;

let isRunning = false;

async function tick() {
  if (isRunning || !getProvider()) return;
  isRunning = true;
  try {
    const { data: accounts, error } = await supabase
      .from("social_accounts")
      .select("user_id")
      .eq("platform", "twitter");
    if (error) { console.error("Readiness worker: failed to fetch accounts:", error.message); return; }

    const userIds = [...new Set((accounts ?? []).map((a) => a.user_id))];
    if (userIds.length === 0) return;

    const { data: snaps } = await supabase
      .from("readiness_snapshots")
      .select("user_id, created_at")
      .in("user_id", userIds)
      .order("created_at", { ascending: false });
    const lastByUser = new Map<string, string>();
    for (const s of snaps ?? []) if (!lastByUser.has(s.user_id)) lastByUser.set(s.user_id, s.created_at);

    // Creators whose posts were never saved for Trending (e.g. scored before that existed) are due too.
    const { data: stored } = await supabase.from("x_posts").select("user_id").in("user_id", userIds).limit(10000);
    const haveStoredPosts = new Set((stored ?? []).map((r: { user_id: string }) => r.user_id));

    const now = Date.now();
    const due = userIds
      .filter((id) => {
        const last = lastByUser.get(id);
        return !last || !haveStoredPosts.has(id) || now - new Date(last).getTime() > STALE_AFTER_MS;
      })
      .slice(0, BATCH_SIZE);

    for (const id of due) {
      try {
        await computeAndStoreReadiness(id);
      } catch (err: any) {
        console.error(`Readiness worker: error for user ${id}:`, err.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startReadinessWorker() {
  console.log(getProvider() ? "⚙️  Readiness worker started" : "⚙️  Readiness worker idle: no data provider configured");
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
}
