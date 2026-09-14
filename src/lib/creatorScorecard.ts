// src/lib/creatorScorecard.ts
//
// The Creator Profile page's "Creator Score" widget — five categories, four
// with a real data source today:
//   - Influence & Engagement reuse the existing Influence Rating engine
//     (scoringData.ts) rather than recomputing anything.
//   - Reliability and Content Quality are computed here from claims/
//     video_analysis.
//   - Conversion has no data source anywhere in the app (no attribution/
//     click-through tracking exists) and is intentionally never computed or
//     stored — the frontend renders it as a locked "Coming soon" tab and it
//     never enters the overall-score math.
// A category that has no data yet is null, not zero, and drops out of the
// weighted average rather than dragging the creator's score down for
// something they haven't had a chance to do yet.

import { supabase } from "./supabase";

async function computeContentQuality(creatorId: string): Promise<number | null> {
  const { data } = await supabase
    .from("video_analysis")
    .select("authenticity_score")
    .eq("creator_id", creatorId)
    .not("authenticity_score", "is", null);

  const rows = data ?? [];
  if (rows.length === 0) return null;

  const avg = rows.reduce((s, r) => s + Number(r.authenticity_score || 0), 0) / rows.length;
  return Math.round(avg);
}

async function computeReliability(creatorId: string): Promise<number | null> {
  const { data } = await supabase
    .from("claims")
    .select("status")
    .eq("user_id", creatorId);

  const rows = data ?? [];
  if (rows.length === 0) return null;

  const paid = rows.filter((r) => r.status === "paid").length;
  return Math.round((paid / rows.length) * 100);
}

interface WeightedCategory { key: string; value: number | null; weight: number }

function weightedAverage(categories: WeightedCategory[]): number {
  const available = categories.filter((c) => c.value !== null);
  const totalWeight = available.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const sum = available.reduce((s, c) => s + (c.value as number) * c.weight, 0);
  return Math.round(sum / totalWeight);
}

export async function calculateAndStoreScorecard(creatorId: string): Promise<void> {
  const { data: influenceRow } = await supabase
    .from("creator_influence_scores")
    .select("audience_score, engagement_score, impact_score")
    .eq("creator_id", creatorId)
    .single();

  // No Influence Rating yet means no real Influence/Engagement signal either —
  // nothing honest to build a scorecard from, so skip entirely rather than
  // write a fabricated one. (Mirrors calculateAndStoreInfluenceScore's own
  // "nothing to score yet" early return.)
  if (!influenceRow) return;

  const influenceScore = Math.round((Number(influenceRow.audience_score) + Number(influenceRow.impact_score)) / 2);
  const engagementScore = Math.round(Number(influenceRow.engagement_score));

  const [contentQualityScore, reliabilityScore] = await Promise.all([
    computeContentQuality(creatorId),
    computeReliability(creatorId),
  ]);

  const overallScore = weightedAverage([
    { key: "influence", value: influenceScore, weight: 0.3 },
    { key: "engagement", value: engagementScore, weight: 0.3 },
    { key: "contentQuality", value: contentQualityScore, weight: 0.2 },
    { key: "reliability", value: reliabilityScore, weight: 0.2 },
  ]);

  const now = new Date().toISOString();

  const { error: upsertError } = await supabase
    .from("creator_scorecards")
    .upsert(
      {
        creator_id: creatorId,
        overall_score: overallScore,
        influence_score: influenceScore,
        engagement_score: engagementScore,
        content_quality_score: contentQualityScore,
        reliability_score: reliabilityScore,
        calculated_at: now,
        updated_at: now,
      },
      { onConflict: "creator_id" }
    );

  if (upsertError) {
    console.error(`Scorecard: failed to upsert for creator ${creatorId}:`, upsertError.message);
    return;
  }

  // Niche percentile — only meaningful once the creator has actually set one.
  const { data: creator } = await supabase.from("users").select("niche").eq("id", creatorId).single();
  const niche = creator?.niche;
  if (!niche) return;

  const { data: peers } = await supabase
    .from("creator_scorecards")
    .select("creator_id, overall_score, users:creator_id ( niche )")
    .eq("users.niche", niche);

  const peerRows = (peers ?? []) as { creator_id: string; overall_score: number }[];
  if (peerRows.length === 0) return;

  const countLessEq = peerRows.filter((p) => p.overall_score <= overallScore).length;
  const nichePercentile = Math.round((countLessEq / peerRows.length) * 100);

  await supabase.from("creator_scorecards").update({ niche_percentile: nichePercentile }).eq("creator_id", creatorId);
}
