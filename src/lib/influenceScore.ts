// src/lib/influenceScore.ts
//
// Pure scoring math for the cross-platform "Influence Rating". No DB or
// network calls here — see scoringData.ts for how raw platform data gets
// turned into the inputs these functions expect.
//
// Formula (three pillars — Audience Quality was dropped: neither TikTok's
// nor Instagram's API exposes who's engaging with a creator, so there's no
// honest data source for it):
//
//   FinalScore(0-100) = audience*0.35 + engagement*0.45 + impact*0.20
//   Rating             = 100 + FinalScore * 9   → range 100-1000
//
// Every log-scaled term uses log10(x+1) against a fixed reference ceiling,
// so growth has diminishing returns (1K→10K followers matters far more
// than 1M→1.1M) without ever going negative or needing real-time
// percentile data to normalize against.

function logScale(value: number, ceiling: number): number {
  const scaled = Math.log10(Math.max(0, value) + 1) / Math.log10(ceiling + 1);
  return Math.min(100, Math.max(0, scaled * 100));
}

/** Redistribute a null term's weight proportionally across the remaining terms,
 *  instead of treating missing platform data (e.g. Instagram has no share count) as zero. */
function redistributeWeights(
  weights: Record<string, number>,
  nullKeys: string[]
): Record<string, number> {
  const droppedWeight = nullKeys.reduce((sum, k) => sum + weights[k], 0);
  const remainingKeys = Object.keys(weights).filter((k) => !nullKeys.includes(k));
  const remainingWeight = remainingKeys.reduce((sum, k) => sum + weights[k], 0);
  if (remainingWeight === 0) return weights;

  const result = { ...weights };
  for (const k of nullKeys) result[k] = 0;
  for (const k of remainingKeys) result[k] = weights[k] + (weights[k] / remainingWeight) * droppedWeight;
  return result;
}

// ── Audience — 25% of the original spec's weighting, rebalanced to 35% ────
export function audienceScore(followers: number): number {
  return Math.round(logScale(followers, 10_000_000));
}

// ── Engagement — rebalanced to 45% ─────────────────────────────────────────
export interface EngagementInput {
  engagementRatePct: number;     // 0-100
  avgLikes: number;
  avgComments: number;
  avgShares: number | null;      // null on platforms that don't expose shares (Instagram)
}

const ENGAGEMENT_WEIGHTS = { rate: 0.39, likes: 0.28, comments: 0.22, shares: 0.11 };
const AVG_LIKES_CEILING = 50_000;
const AVG_COMMENTS_CEILING = 2_000;
const AVG_SHARES_CEILING = 5_000;

export function engagementScore({ engagementRatePct, avgLikes, avgComments, avgShares }: EngagementInput): number {
  const weights = avgShares === null
    ? redistributeWeights(ENGAGEMENT_WEIGHTS, ["shares"])
    : ENGAGEMENT_WEIGHTS;

  const rateTerm     = Math.min(100, (engagementRatePct / 15) * 100); // 15%+ engagement rate = maxed
  const likesTerm     = logScale(avgLikes, AVG_LIKES_CEILING);
  const commentsTerm  = logScale(avgComments, AVG_COMMENTS_CEILING);
  const sharesTerm    = avgShares === null ? 0 : logScale(avgShares, AVG_SHARES_CEILING);

  const score =
    rateTerm * weights.rate +
    likesTerm * weights.likes +
    commentsTerm * weights.comments +
    sharesTerm * weights.shares;

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ── Impact — rebalanced to 20% ──────────────────────────────────────────────
export interface ImpactInput {
  totalLikes: number;
  totalViews: number | null;     // null on platforms that don't expose per-post views (Instagram)
  totalComments: number;
  totalShares: number | null;    // null on platforms that don't expose shares (Instagram)
}

const IMPACT_WEIGHTS = { likes: 0.4, views: 0.3, comments: 0.15, shares: 0.15 };
const TOTAL_LIKES_CEILING = 10_000_000;
const TOTAL_VIEWS_CEILING = 100_000_000;
const TOTAL_COMMENTS_CEILING = 500_000;
const TOTAL_SHARES_CEILING = 1_000_000;

export function impactScore({ totalLikes, totalViews, totalComments, totalShares }: ImpactInput): number {
  const nullKeys: ("views" | "shares")[] = [];
  if (totalViews === null) nullKeys.push("views");
  if (totalShares === null) nullKeys.push("shares");
  const weights = nullKeys.length > 0 ? redistributeWeights(IMPACT_WEIGHTS, nullKeys) : IMPACT_WEIGHTS;

  const likesTerm    = logScale(totalLikes, TOTAL_LIKES_CEILING);
  const viewsTerm     = totalViews === null ? 0 : logScale(totalViews, TOTAL_VIEWS_CEILING);
  const commentsTerm  = logScale(totalComments, TOTAL_COMMENTS_CEILING);
  const sharesTerm    = totalShares === null ? 0 : logScale(totalShares, TOTAL_SHARES_CEILING);

  const score =
    likesTerm * weights.likes +
    viewsTerm * weights.views +
    commentsTerm * weights.comments +
    sharesTerm * weights.shares;

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ── Combining platforms ──────────────────────────────────────────────────
export interface PlatformPillarScores {
  followers: number;
  audience: number;
  engagement: number;
  impact: number;
}

// Multi-platform creators get each pillar blended by follower-weighted
// average (their bigger platform counts for more) — not a modeled
// "shared audience" adjustment. Good enough for two platforms; revisit if
// a creator with heavily overlapping audiences across many platforms
// turns out to be a real problem.
export function combinePlatformScores(platforms: PlatformPillarScores[]): {
  audience: number; engagement: number; impact: number;
} {
  if (platforms.length === 0) return { audience: 0, engagement: 0, impact: 0 };
  if (platforms.length === 1) {
    const [p] = platforms;
    return { audience: p.audience, engagement: p.engagement, impact: p.impact };
  }

  const totalFollowers = platforms.reduce((sum, p) => sum + p.followers, 0);
  const weight = (p: PlatformPillarScores) => (totalFollowers > 0 ? p.followers / totalFollowers : 1 / platforms.length);

  return {
    audience:   Math.round(platforms.reduce((sum, p) => sum + p.audience * weight(p), 0)),
    engagement: Math.round(platforms.reduce((sum, p) => sum + p.engagement * weight(p), 0)),
    impact:     Math.round(platforms.reduce((sum, p) => sum + p.impact * weight(p), 0)),
  };
}

// ── Final rating ─────────────────────────────────────────────────────────
const PILLAR_WEIGHTS = { audience: 0.35, engagement: 0.45, impact: 0.20 };

export function finalRating(audience: number, engagement: number, impact: number): number {
  const finalScore =
    audience * PILLAR_WEIGHTS.audience +
    engagement * PILLAR_WEIGHTS.engagement +
    impact * PILLAR_WEIGHTS.impact;

  return Math.round(Math.min(1000, Math.max(100, 100 + finalScore * 9)));
}

// ── Confidence ───────────────────────────────────────────────────────────
// 10+ posts considered = full confidence; fewer = proportionally lower.
// A brand-new connect with 0 posts still gets a real rating off audience
// alone — this just tells the frontend how much to trust it.
export function confidenceScore(postsConsidered: number): number {
  return Math.min(100, Math.round((postsConsidered / 10) * 100));
}
