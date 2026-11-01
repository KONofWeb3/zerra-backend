import type { FollowerLite } from "./types";

// Mirrors zerra/src/lib/readiness.ts (the UI recomputes signals from stored
// inputs). Keep the targets, weights and tiers in sync with that file.
export const TARGETS = { qualityFollowers: 1000, engagementPerPost: 50, posts: 12 } as const;
const WEIGHTS = { followers: 0.4, engagement: 0.4, consistency: 0.2 } as const;

const TIERS = [
  { name: "Emerging", min: 0 },
  { name: "Gaining Recognition", min: 40 },
  { name: "Near Target", min: 60 },
  { name: "High Readiness", min: 80 },
];

const pct = (v: number, t: number) => 100 * Math.min(Math.max(v, 0) / t, 1);

export function readinessScore(i: {
  qualityFollowers: number;
  engagementPerPost: number | null;
  posts: number;
}): { score: number; tier: string } {
  const parts: { s: number; w: number }[] = [
    { s: pct(i.qualityFollowers, TARGETS.qualityFollowers), w: WEIGHTS.followers },
    { s: pct(i.posts, TARGETS.posts), w: WEIGHTS.consistency },
  ];
  if (i.engagementPerPost != null) {
    parts.push({ s: pct(i.engagementPerPost, TARGETS.engagementPerPost), w: WEIGHTS.engagement });
  }
  const totalW = parts.reduce((a, p) => a + p.w, 0);
  const score = parts.reduce((a, p) => a + p.s * p.w, 0) / totalW;
  const tier = [...TIERS].reverse().find((t) => score >= t.min)!.name;
  return { score: Math.round(score * 10) / 10, tier };
}

export const QUALITY_THRESHOLD = 50;

/**
 * 0-100 quality score for one follower. Brand-new, empty or botlike accounts
 * score 0. This is Zerra's own heuristic, not Kaito's classification.
 */
export function followerQuality(f: FollowerLite, now = Date.now()): number {
  const ageDays = f.createdAt ? (now - new Date(f.createdAt).getTime()) / 86_400_000 : 0;
  if (!f.createdAt || ageDays < 90) return 0;
  if (f.statuses < 20) return 0;
  if (f.following > 20 * Math.max(f.followers, 1) && f.followers < 100) return 0; // follow-farming pattern

  const age = ageDays > 1095 ? 30 : ageDays > 365 ? 20 : 10;
  const reach = Math.min(30, (Math.log10(Math.max(f.followers, 1)) / 3) * 30); // 1k followers = full marks
  const ratio = f.followers / Math.max(f.following, 1);
  const ratioPts = ratio >= 1 ? 15 : ratio >= 0.5 ? 8 : 0;
  const activity = f.statuses >= 500 ? 15 : f.statuses >= 100 ? 8 : 3;
  const verified = f.verified ? 10 : 0;
  return Math.round(age + reach + ratioPts + activity + verified);
}
