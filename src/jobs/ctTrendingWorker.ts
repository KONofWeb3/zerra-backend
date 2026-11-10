// Collects the most popular posts on Crypto Twitter for the Trending page.
//
// Every few hours it runs a handful of topic searches (Top results, last 24h) through the data
// provider and keeps the posts. It does nothing unless a provider is configured (TWITTERAPI_IO_KEY).
// Each search is one page of up to 20 posts, so a run is a few cents at most.

import { supabase } from "../lib/supabase";
import { getProvider } from "../lib/readiness/providers";
import type { CtPost } from "../lib/readiness/types";
import { computeDiscovery } from "../lib/readiness/discovery";

const INTERVAL_MS = 3 * 60 * 60 * 1000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days: the credible-account suggestions look at a month, not a day
const MIN_VIEWS = 1000; // skip posts nobody saw

// Broad CT coverage first, then the topics we rank creators on, so the page isn't all one narrative.
const TOPICS: { label: string; query: string }[] = [
  { label: "Bitcoin & majors", query: `(crypto OR bitcoin OR ethereum OR solana OR altcoin OR altcoins)` },
  { label: "Major tokens", query: `($BTC OR $ETH OR $SOL OR $BNB OR $XRP)` },
  { label: "DeFi & protocols", query: `(DeFi OR hyperliquid OR perps OR restaking OR stablecoin OR stablecoins OR lending OR DEX)` },
  { label: "AI x Crypto", query: `(AI agents OR "AI agent" OR agentic OR $TAO OR virtuals) crypto` },
  { label: "Memecoins", query: `(memecoin OR memecoins OR pumpfun OR "pump.fun")` },
  { label: "NFTs & gaming", query: `(NFT OR NFTs OR ordinals OR "digital art" OR web3gaming OR "crypto gaming") crypto` },
  { label: "Airdrops & campaigns", query: `(airdrop OR airdrops OR TGE OR "points farming" OR testnet)` },
  { label: "ETFs & RWA", query: `("bitcoin ETF" OR "ETH ETF" OR RWA OR tokenized OR "crypto market" OR institutional)` },
];
const PAGES = 3; // pages of 20 posts per search

let isRunning = false;

async function collect(sinceUnix: number, untilUnix?: number): Promise<number> {
  const found = new Map<string, CtPost>();
  const labels = new Map<string, Set<string>>();
  const provider = getProvider();
  if (!provider) return 0;
  for (const topic of TOPICS) {
    try {
      const range = `since_time:${sinceUnix}${untilUnix ? ` until_time:${untilUnix}` : ""}`;
      const posts = await provider.searchPosts(`${topic.query} ${range} -filter:replies`, PAGES);
      for (const p of posts) {
        if (p.views < MIN_VIEWS) continue;
        found.set(p.id, p);
        let set = labels.get(p.id);
        if (!set) { set = new Set(); labels.set(p.id, set); }
        set.add(topic.label);
      }
    } catch (err: any) {
      console.error("CT trending: search failed:", err.message);
    }
  }

  // Keep every keyword a post was ever found by.
  const before = new Map<string, string[]>();
  const ids = [...found.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from("ct_posts").select("post_id, keywords").in("post_id", ids.slice(i, i + 200));
    for (const r of data ?? []) before.set(r.post_id, r.keywords ?? []);
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
      kind: p.kind,
      author_id: p.authorId,
      keywords: [...new Set([...(before.get(p.id) ?? []), ...(labels.get(p.id) ?? [])])],
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
    await computeDiscovery();
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
