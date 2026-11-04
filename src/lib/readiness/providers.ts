import type { FollowerLite, PostLite, XDataProvider } from "./types";

const BASE = "https://api.twitterapi.io";

// TwitterAPI.io rate-limits by account: roughly one request every 5 seconds
// until the account has paid, far more after. Every call goes through one
// queue (so a user's followers and posts requests, and different users'
// refreshes, never overlap). It starts fast and, on a 429, slows to the free
// tier's pace and retries, so a paid account isn't throttled needlessly.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FREE_TIER_GAP_MS = 5200;
let gapMs = 1000;
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCallAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function get(path: string, params: Record<string, string>, key: string) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await schedule(() => fetch(url, { headers: { "X-API-Key": key } }));
    if (res.status === 429 && attempt < 4) {
      gapMs = Math.max(gapMs, FREE_TIER_GAP_MS);
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : FREE_TIER_GAP_MS);
      continue;
    }
    if (!res.ok) throw new Error(`TwitterAPI.io ${path} -> ${res.status}`);
    const body: any = await res.json();
    if (body.status && body.status !== "success") throw new Error(`TwitterAPI.io ${path}: ${body.msg ?? "error"}`);
    return body;
  }
}

// Endpoint shapes from docs.twitterapi.io (followers by userName, 200/page,
// billed per follower returned; last_tweets 20/page). Not yet exercised
// against the live API: test with a real key before relying on it.
export function twitterApiIoProvider(key: string): XDataProvider {
  return {
    name: "twitterapi.io",

    async getFollowerSample(username, max) {
      const out: FollowerLite[] = [];
      let cursor = "";
      while (out.length < max) {
        const body = await get("/twitter/user/followers", { userName: username, cursor, pageSize: "200" }, key);
        for (const f of body.followers ?? []) {
          out.push({
            id: String(f.id),
            username: String(f.userName ?? f.screen_name ?? "").toLowerCase(),
            createdAt: f.created_at ?? null,
            followers: Number(f.followers_count ?? 0),
            following: Number(f.following_count ?? f.friends_count ?? 0),
            statuses: Number(f.statuses_count ?? 0),
            verified: Boolean(f.isBlueVerified || f.verified),
          });
        }
        if (!body.has_next_page || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return out.slice(0, max);
    },

    async getRecentPosts(username, sinceMs) {
      const out: PostLite[] = [];
      let cursor = "";
      for (let page = 0; page < 2; page++) {
        const body = await get("/twitter/user/last_tweets", { userName: username, cursor, includeReplies: "false" }, key);
        const tweets: any[] = body.data?.tweets ?? [];
        let reachedOld = false;
        for (const t of tweets) {
          const at = new Date(t.createdAt).getTime();
          if (at < sinceMs) { reachedOld = true; continue; }
          out.push({ id: String(t.id), createdAt: t.createdAt, isReply: Boolean(t.isReply) });
        }
        if (reachedOld || !body.has_next_page || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return out;
    },
  };
}

// Deterministic fake for local development only. Never selected in production.
function fakeProvider(): XDataProvider {
  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return {
    name: "fake",
    async getFollowerSample(username, max) {
      const seed = hash(username);
      return Array.from({ length: Math.min(max, 400) }, (_, i) => {
        const r = hash(`${username}:${i}`) % 100;
        return {
          id: String(seed + i),
          username: `fake_${i}`,
          createdAt: new Date(Date.now() - (r + 30) * 12 * 86_400_000).toISOString(),
          followers: r * 15,
          following: 40 + (r % 30),
          statuses: r * 12,
          verified: r > 92,
        };
      });
    },
    async getRecentPosts(username) {
      const n = 4 + (hash(username) % 14);
      return Array.from({ length: n }, (_, i) => ({ id: String(i), createdAt: new Date().toISOString(), isReply: false }));
    },
  };
}

/** null = no data source configured; callers must treat that as "unavailable", never invent numbers. */
export function getProvider(): XDataProvider | null {
  if (process.env.READINESS_PROVIDER === "fake" && process.env.NODE_ENV !== "production") return fakeProvider();
  const key = process.env.TWITTERAPI_IO_KEY;
  return key ? twitterApiIoProvider(key) : null;
}
