// src/jobs/influenceScoreWorker.ts
//
// Keeps every connected creator's Influence Rating fresh without requiring
// them to reconnect or reload anything. Same polling-worker pattern as
// verificationWorker.ts — runs on an interval inside the same Express
// process, no external queue.

import { supabase } from "../lib/supabase";
import { calculateAndStoreInfluenceScore } from "../lib/scoringData";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const BATCH_SIZE = 25;                        // bound Instagram API calls per tick
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;   // recalculate once a score is a day old

let isRunning = false; // simple lock so overlapping ticks can't double-process

async function tick() {
  if (isRunning) return; // previous tick still running, skip this one
  isRunning = true;

  try {
    const { data: accounts, error: accountsError } = await supabase
      .from("social_accounts")
      .select("user_id");

    if (accountsError) {
      console.error("Influence score worker: failed to fetch social_accounts:", accountsError.message);
      return;
    }

    const creatorIds = Array.from(new Set((accounts ?? []).map((a) => a.user_id)));
    if (creatorIds.length === 0) return;

    const { data: scores, error: scoresError } = await supabase
      .from("creator_influence_scores")
      .select("creator_id, calculated_at")
      .in("creator_id", creatorIds);

    if (scoresError) {
      console.error("Influence score worker: failed to fetch creator_influence_scores:", scoresError.message);
      return;
    }

    const calculatedAtByCreator = new Map((scores ?? []).map((s) => [s.creator_id, s.calculated_at]));
    const now = Date.now();

    const due = creatorIds.filter((id) => {
      const calculatedAt = calculatedAtByCreator.get(id);
      return !calculatedAt || now - new Date(calculatedAt).getTime() > STALE_AFTER_MS;
    }).slice(0, BATCH_SIZE);

    if (due.length === 0) return;

    console.log(`Influence score worker: recalculating ${due.length} creator(s)`);

    for (const creatorId of due) {
      try {
        await calculateAndStoreInfluenceScore(creatorId);
      } catch (err: any) {
        console.error(`Influence score worker: error scoring creator ${creatorId}:`, err.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startInfluenceScoreWorker() {
  console.log(`⚙️  Influence score worker started — polling every ${POLL_INTERVAL_MS / 1000 / 60 / 60}h`);
  setInterval(tick, POLL_INTERVAL_MS);
  tick(); // run once immediately on startup too
}
