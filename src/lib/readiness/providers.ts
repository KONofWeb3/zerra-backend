import type { ActivityTweet, CtPost, FollowerLite, PostLite, XDataProvider } from "./types";

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

    async searchPosts(query, pages = 1) {
      const out: CtPost[] = [];
      let cursor = "";
      for (let page = 0; page < pages; page++) {
      const body = await get("/twitter/tweet/advanced_search", { query, queryType: "Top", cursor }, key);
      for (const t of (body.tweets ?? []) as any[]) {
        if (!t?.id || !t.createdAt) continue;
        // Original posts and quote tweets only: no replies, no plain retweets.
        if (t.isReply || t.inReplyToId || t.retweeted_tweet || /^RT @/.test(String(t.text ?? ""))) continue;
        const handle = t.author?.userName;
        if (typeof handle !== "string" || !handle) continue;
        const followers = Number(t.author?.followers);
        out.push({
          id: String(t.id),
          text: String(t.text ?? ""),
          createdAt: t.createdAt,
          likes: Number(t.likeCount ?? 0),
          replies: Number(t.replyCount ?? 0),
          retweets: Number(t.retweetCount ?? 0),
          quotes: Number(t.quoteCount ?? 0),
          views: Number(t.viewCount ?? 0),
          handle,
          name: typeof t.author?.name === "string" ? t.author.name : null,
          avatar: typeof t.author?.profilePicture === "string" ? t.author.profilePicture : null,
          followers: Number.isFinite(followers) ? followers : null,
          kind: t.quoted_tweet ? "quote" : "original",
          authorId: t.author?.id ? String(t.author.id) : null,
        });
      }
      if (!body.has_next_page || !body.next_cursor) break;
      cursor = String(body.next_cursor);
      }
      return out;
    },

    async searchUsers(query) {
      const body = await get("/twitter/user/search", { query, cursor: "" }, key);
      return ((body.users ?? []) as any[]).flatMap((u) => {
        const handle = u?.screen_name ?? u?.userName ?? u?.username;
        if (typeof handle !== "string" || !handle) return [];
        const followers = Number(u.followers_count);
        const pic = u.profile_image_url_https ?? u.profilePicture;
        return [{
          handle,
          name: typeof u.name === "string" && u.name.trim() ? u.name.trim() : null,
          avatar: typeof pic === "string" && pic.startsWith("http") ? pic : null,
          followers: Number.isFinite(followers) ? followers : null,
          verified: Boolean(u.isBlueVerified || u.verified),
        }];
      });
    },

    async getUserProfile(username) {
      const body = await get("/twitter/user/info", { userName: username }, key);
      const d = body.data ?? {};
      const pic = d.profilePicture ?? d.profile_image_url_https;
      const followers = Number(d.followers ?? d.followers_count);
      return {
        name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : null,
        avatarUrl: typeof pic === "string" && pic.startsWith("http") ? pic : null,
        followers: Number.isFinite(followers) && followers > 0 ? followers : null,
      };
    },

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
            likes: Number(f.favourites_count ?? 0),
            hasBio: Boolean(String(f.description ?? "").trim()),
            verified: Boolean(f.isBlueVerified || f.verified),
          });
        }
        if (!body.has_next_page || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return out.slice(0, max);
    },

    async getActivity(username, sinceMs) {
      const out: ActivityTweet[] = [];
      let cursor = "";
      for (let page = 0; page < 8; page++) {
        const body = await get("/twitter/user/last_tweets", { userName: username, cursor, includeReplies: "true" }, key);
        let reachedOld = false;
        for (const t of (body.data?.tweets ?? []) as any[]) {
          if (!t?.id || !t.createdAt) continue;
          const at = new Date(t.createdAt).getTime();
          if (Number.isNaN(at)) continue;
          if (at < sinceMs) { reachedOld = true; continue; }
          const text = String(t.text ?? "");
          out.push({
            id: String(t.id),
            createdAt: new Date(at).toISOString(),
            text,
            isReply: Boolean(t.isReply || t.inReplyToId),
            inReplyToId: t.inReplyToId ? String(t.inReplyToId) : null,
            inReplyToUsername: typeof t.inReplyToUsername === "string" ? t.inReplyToUsername : null,
            isRetweet: Boolean(t.retweeted_tweet) || /^RT @/.test(text),
            // X Articles: an explicit article object, or a link to one.
            isArticle: Boolean(t.article) || /(?:x|twitter)\.com\/i\/article\//i.test(text + " " + JSON.stringify(t.entities?.urls ?? "")),
          });
        }
        // Pinned tweets can be old and out of order, so only stop once a whole page is old.
        if (reachedOld && (body.data?.tweets ?? []).every((t: any) => new Date(t.createdAt).getTime() < sinceMs)) break;
        if (!body.has_next_page || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return out;
    },

    async getRecentPosts(username, sinceMs) {
      const out: PostLite[] = [];
      let followers: number | null = null;
      let displayName: string | null = null;
      let avatarUrl: string | null = null;
      let cursor = "";
      for (let page = 0; page < 3; page++) {
        const body = await get("/twitter/user/last_tweets", { userName: username, cursor, includeReplies: "false" }, key);
        const tweets: any[] = body.data?.tweets ?? [];
        let reachedOld = false;
        for (const t of tweets) {
          if (followers == null) {
            const n = Number(t.author?.followers ?? t.author?.followers_count);
            if (Number.isFinite(n) && n > 0) followers = n;
          }
          if (displayName == null && typeof t.author?.name === "string" && t.author.name.trim()) {
            displayName = t.author.name.trim();
          }
          if (avatarUrl == null) {
            const pic = t.author?.profilePicture ?? t.author?.profile_image_url_https;
            if (typeof pic === "string" && pic.startsWith("http")) avatarUrl = pic;
          }
          // Only original tweets and quote tweets count: no replies (comments) and no plain retweets.
          if (t.isReply || t.inReplyToId || t.retweeted_tweet || /^RT @/.test(String(t.text ?? ""))) continue;
          const at = new Date(t.createdAt).getTime();
          if (at < sinceMs) { reachedOld = true; continue; }
          out.push({
            id: String(t.id),
            createdAt: t.createdAt,
            isReply: Boolean(t.isReply),
            text: String(t.text ?? ""),
            likes: Number(t.likeCount ?? 0),
            replies: Number(t.replyCount ?? 0),
            retweets: Number(t.retweetCount ?? 0),
            quotes: Number(t.quoteCount ?? 0),
            views: Number(t.viewCount ?? 0),
          });
        }
        if (reachedOld || !body.has_next_page || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return { posts: out.filter((p) => !p.isReply), followers, displayName, avatarUrl };
    },
  };
}

// Deterministic fake for local development only. Never selected in production.
function fakeProvider(): XDataProvider {
  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return {
    name: "fake",
    async searchPosts() {
      return [];
    },
    async searchUsers() {
      return [];
    },
    async getActivity() {
      return [];
    },
    async getUserProfile() {
      return { name: null, avatarUrl: null, followers: null };
    },
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
          likes: r * 20,
          hasBio: r % 3 !== 0,
          verified: r > 92,
        };
      });
    },
    async getRecentPosts(username) {
      const n = 4 + (hash(username) % 14);
      const topics = ["DeFi yield on Aave today", "AI agents are the next wave", "Bitcoin halving thoughts", "NFT floor price update", "Building in public: shipped a feature"];
      return {
        followers: null,
        displayName: null,
        avatarUrl: null,
        posts: Array.from({ length: n }, (_, i) => ({
          id: String(i),
          createdAt: new Date(Date.now() - i * 2.5 * 86_400_000).toISOString(),
          isReply: false,
          text: topics[i % topics.length],
          likes: 20 + (hash(`${username}${i}`) % 80),
          replies: 3,
          retweets: 5,
          quotes: 1,
          views: 2000 + (hash(`${username}v${i}`) % 3000),
        })),
      };
    },
  };
}

/** null = no data source configured; callers must treat that as "unavailable", never invent numbers. */
export function getProvider(): XDataProvider | null {
  if (process.env.READINESS_PROVIDER === "fake" && process.env.NODE_ENV !== "production") return fakeProvider();
  const key = process.env.TWITTERAPI_IO_KEY;
  return key ? twitterApiIoProvider(key) : null;
}
