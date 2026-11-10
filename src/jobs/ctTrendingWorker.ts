// Collects the most popular posts on Crypto Twitter for the Trending page.
//
// Every few hours it runs a handful of topic searches (Top results, last 24h) through the data
// provider and keeps the posts. It does nothing unless a provider is configured (TWITTERAPI_IO_KEY).
// Each search is one page of up to 20 posts, so a run is a few cents at most.

import { supabase } from "../lib/supabase";
import { getProvider } from "../lib/readiness/providers";
import type { CtPost } from "../lib/readiness/types";

const INTERVAL_MS = 3 * 60 * 60 * 1000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days: the credible-account suggestions look at a month, not a day
const MIN_VIEWS = 1000; // skip posts nobody saw

// Broad CT coverage first, then the topics we rank creators on, so the page isn't all one narrative.
const TOPICS = [
  `(crypto OR bitcoin OR ethereum OR solana OR altcoin OR altcoins)`,
  `($BTC OR $ETH OR $SOL OR $BNB OR $XRP)`,
  `(DeFi OR hyperliquid OR perps OR restaking OR stablecoin OR stablecoins)`,
  `(AI agents OR "AI agent" OR agentic OR $TAO OR virtuals) crypto`,
  `(memecoin OR memecoins OR pumpfun OR "pump.fun")`,
  `(NFT OR NFTs OR ordinals OR "digital art") crypto`,
  `(airdrop OR airdrops OR TGE OR "points farming")`,
  `("bitcoin ETF" OR "ETH ETF" OR RWA OR tokenized OR "crypto market")`,
];

let isRunning = false;

async function collect(sinceUnix: number, untilUnix?: number): Promise<number> {
  const found = new Map<string, CtPost>();
  const provider = getProvider();
  if (!provider) return 0;
  for (const topic of TOPICS) {
    try {
      const range = `since_time:${sinceUnix}${untilUnix ? ` until_time:${untilUnix}` : ""}`;
      const posts = await provider.searchPosts(`${topic} ${range} -filter:replies`);
      for (const p of posts) if (p.views >= MIN_VIEWS) found.set(p.id, p);
    } catch (err: any) {
      console.error("CT trending: search failed:", err.message);
    }
  }

  const rows = [...found.values()].flatMap((p) => {
    const at = new Date(p.createdAt);
    if (Number.isNaN(at.getTime())) return []; // the provider's date format is not Postgres-friendly, so convert
    return [{
      post_id: p.id,
      text: p.text.slice(0, 1000),
      posted_at: at.toISOString(),
      likes: p.likes,
      replies: p.replies,
      retweets: p.retweets,
      quotes: p.quotes,
      views: p.views,
      handle: p.handle,
      name: p.name,
      avatar: p.avatar,
      followers: p.followers,
      fetched_at: new Date().toISOString(),
    }];
  });

  if (rows.length) {
    const { error } = await supabase.from("ct_posts").upsert(rows, { onConflict: "post_id" });
    if (error) console.error("CT trending: saving posts failed:", error.message);
    else console.log(`CT trending: saved ${rows.length} posts`);
  }
  return rows.length;
}

/** Fill in the past month (a week at a time) when we don't have it yet, so suggestions can look at 30 days. */
async function backfillIfNeeded() {
  const olderThan = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase.from("ct_posts").select("post_id", { count: "exact", head: true }).lt("posted_at", olderThan);
  if ((count ?? 0) >= 200) return;
  console.log("CT trending: backfilling the last 30 days");
  const DAY = 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  for (let w = 4; w >= 1; w--) {
    await collect(now - w * 7 * DAY, now - (w - 1) * 7 * DAY);
  }
}

async function tick() {
  const provider = getProvider();
  if (!provider || isRunning) return;
  isRunning = true;
  try {
    await backfillIfNeeded();
    await collect(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000));
    const cutoff = new Date(Date.now() - KEEP_MS).toISOString();
    await supabase.from("ct_posts").delete().lt("posted_at", cutoff);
  } finally {
    isRunning = false;
  }
}

export function startCtTrendingWorker() {
  console.log(getProvider() ? "⚙️  CT trending worker started" : "⚙️  CT trending worker idle: no data provider configured");
  setInterval(tick, INTERVAL_MS);
  // Give the server a moment to settle (and the readiness job to take its turn at the rate limit) first.
  setTimeout(tick, 60_000);
}
