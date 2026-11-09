import type { FollowerLite } from "./types";

// Smart Readiness v2. The final score is a weighted blend of five components,
// then multiplied by an inactivity gate: an account that has stopped posting
// loses influence no matter how big it is. Mirrors the labels in
// zerra/src/lib/readiness.ts (tiers and weights must stay in sync).

export const ALGO_VERSION = 2;

export const WEIGHTS = {
  reach: 0.2,
  audience: 0.2,
  engagement: 0.25,
  activity: 0.2,
  momentum: 0.15,
} as const;
export type ComponentKey = keyof typeof WEIGHTS;

export const TIERS = [
  { name: "Emerging CT", min: 0 },
  { name: "Discovered", min: 20 },
  { name: "Recognised CT", min: 40 },
  { name: "Inner Circle", min: 60 },
  { name: "Elite Inner Circle", min: 80 },
];

/** Piecewise-linear lookup. `points` are [x, y] sorted by x; x is clamped to the ends. */
export function interp(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

// Followers on a log scale: 1k is a modest account, 20k is strong, 100k+ is top-tier.
const REACH_CURVE = [[0, 0], [100, 10], [500, 25], [1_000, 35], [5_000, 55], [10_000, 67], [20_000, 78], [50_000, 90], [100_000, 96], [1_000_000, 100]] as const;
// Engagements per view (likes + replies + reposts + quotes) / views.
export const ER_CURVE = [[0, 0], [0.002, 10], [0.005, 25], [0.01, 40], [0.02, 60], [0.04, 80], [0.07, 100]] as const;
// Median views per post relative to follower count (how much of the audience actually sees you).
const VIEW_RATIO_CURVE = [[0, 0], [0.02, 10], [0.05, 25], [0.15, 50], [0.4, 75], [1, 100]] as const;
const CADENCE_CURVE = [[0, 0], [3, 35], [8, 65], [12, 85], [20, 100]] as const;
const RECENCY_CURVE = [[0, 100], [2, 100], [7, 70], [14, 45], [30, 15], [60, 0]] as const;
const ER_TREND_CURVE = [[-0.5, 0], [0, 50], [0.5, 100]] as const;
const GROWTH_CURVE = [[-0.03, 0], [0, 50], [0.05, 100]] as const;

export interface ScoreInput {
  followers: number;
  meanFollowerQuality: number; // 0-100 over the sample
  strongShare: number;         // 0-1, sampled followers rated strong (or on the seed list)
  seedShare: number;           // 0-1, sampled followers on the seed list
  posts30: number;
  daysSinceLastPost: number | null; // null = nothing posted in the window
  erViews: number | null;
  viewsPerFollower: number | null;
  erTrend: number | null;      // +0.2 = engagement up 20% vs the previous 30 days
  followerGrowth: number | null; // fraction per 30 days, from our snapshots
}

export interface ScoreResult {
  score: number;
  tier: string;
  gate: number;
  /** 0-100 per component; momentum is null until there is enough history. */
  components: Record<ComponentKey, number | null>;
}

function inactivityGate(days: number | null): number {
  if (days == null || days > 60) return 0.55;
  if (days > 30) return 0.7;
  if (days > 14) return 0.85;
  if (days > 7) return 0.94;
  return 1;
}

export function scoreReadiness(i: ScoreInput): ScoreResult {
  const reach = interp(REACH_CURVE, i.followers);

  const audience = Math.min(
    100,
    0.5 * i.meanFollowerQuality + 0.5 * i.strongShare * 100 + Math.min(20, i.seedShare * 800),
  );

  const engagement =
    i.erViews == null
      ? 0
      : 0.65 * interp(ER_CURVE, i.erViews) +
        0.35 * interp(VIEW_RATIO_CURVE, i.viewsPerFollower ?? 0);

  const recency = i.daysSinceLastPost == null ? 0 : interp(RECENCY_CURVE, i.daysSinceLastPost);
  const activity = i.daysSinceLastPost == null ? 0 : 0.5 * interp(CADENCE_CURVE, i.posts30) + 0.5 * recency;

  const momentumParts: number[] = [];
  if (i.erTrend != null) momentumParts.push(interp(ER_TREND_CURVE, i.erTrend));
  if (i.followerGrowth != null) momentumParts.push(interp(GROWTH_CURVE, i.followerGrowth));
  const momentum = momentumParts.length ? momentumParts.reduce((a, b) => a + b, 0) / momentumParts.length : null;

  const components: Record<ComponentKey, number | null> = { reach, audience, engagement, activity, momentum };

  // Weighted blend over the components we can measure (momentum needs history).
  let weighted = 0;
  let totalW = 0;
  for (const key of Object.keys(WEIGHTS) as ComponentKey[]) {
    const v = components[key];
    if (v == null) continue;
    weighted += v * WEIGHTS[key];
    totalW += WEIGHTS[key];
  }
  const gate = inactivityGate(i.daysSinceLastPost);
  // Scale matters on top of the reach component: a small account can be sharp,
  // but it can't read as influential. 0.55 at no audience up to 1.0 at 1M+.
  const scale = 0.55 + 0.45 * (reach / 100);
  const score = Math.round((weighted / totalW) * gate * scale * 10) / 10;
  const tier = [...TIERS].reverse().find((t) => score >= t.min)!.name;

  const round = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    score,
    tier,
    gate,
    components: {
      reach: round(reach), audience: round(audience), engagement: round(engagement),
      activity: round(activity), momentum: round(momentum),
    },
  };
}

/** Strong follower = rated at least this by followerQuality (or on the seed list). */
export const STRONG_THRESHOLD = 60;

/**
 * 0-100 quality score for one follower. Brand-new, empty or botlike accounts
 * score 0. A heuristic: it rewards age, reach, a healthy follower/following
 * ratio, real posting and liking history, and having a bio.
 */
export function followerQuality(f: FollowerLite, now = Date.now()): number {
  const ageDays = f.createdAt ? (now - new Date(f.createdAt).getTime()) / 86_400_000 : 0;
  if (!f.createdAt || ageDays < 90) return 0;
  if (f.statuses < 20) return 0;
  if (f.following > 20 * Math.max(f.followers, 1) && f.followers < 100) return 0; // follow-farming pattern

  const age = ageDays > 1460 ? 20 : ageDays > 730 ? 15 : ageDays > 365 ? 10 : 5;
  const reach = Math.min(30, (Math.log10(Math.max(f.followers, 1)) / 4) * 30); // 10k followers = full marks
  const ratio = f.followers / Math.max(f.following, 1);
  const ratioPts = ratio >= 2 ? 15 : ratio >= 1 ? 12 : ratio >= 0.5 ? 7 : ratio >= 0.2 ? 3 : 0;
  const activity = f.statuses >= 5000 ? 15 : f.statuses >= 1000 ? 12 : f.statuses >= 300 ? 8 : f.statuses >= 100 ? 5 : 2;
  const likes = f.likes >= 1000 ? 10 : f.likes >= 200 ? 6 : f.likes >= 50 ? 3 : 0;
  const bio = f.hasBio ? 5 : 0;
  const verified = f.verified ? 5 : 0;
  return Math.min(100, Math.round(age + reach + ratioPts + activity + likes + bio + verified));
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
