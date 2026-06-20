// src/jobs/verificationWorker.ts
//
// Polling-based replacement for the Inngest pipeline. Runs on an interval
// inside the same Express process — no external service, no webhook,
// no signing keys. Picks up 'pending' rows from video_analysis and
// processes them through the same verification logic as before.

import { supabase } from "../lib/supabase";
import { analyzeCaptionWithRetry } from "../lib/ai/analyzeCaption";
import { analyzeTranscriptForKeywordsWithRetry } from "../lib/ai/analyzeTranscriptForKeywords";
import { transcribeVideo } from "../lib/ai/transcribeVideo";
import { calculateFinalScore, calculateFallbackScore } from "../lib/ai/calculateScore";

const POLL_INTERVAL_MS = 30_000; // check every 30 seconds
const BATCH_SIZE = 5;            // process up to 5 pending videos per tick, to avoid overload

let isRunning = false; // simple lock so overlapping ticks can't double-process

async function updateLeaderboard(creatorId: string, campaignId: string, scoreIncrement: number) {
  const { data: existing } = await supabase
    .from("leaderboard")
    .select("total_score")
    .eq("creator_id", creatorId)
    .eq("campaign_id", campaignId)
    .single();

  const newTotal = (existing?.total_score ?? 0) + scoreIncrement;

  await supabase.from("leaderboard").upsert(
    { creator_id: creatorId, campaign_id: campaignId, total_score: newTotal, updated_at: new Date().toISOString() },
    { onConflict: "creator_id,campaign_id" }
  );
}

async function processVideo(row: {
  video_id: string;
  creator_id: string;
  campaign_id: string;
  video_url: string;
  caption: string;
  creator_handle: string;
  campaign_name: string;
  required_keywords: string[];
  likes: number;
  views: number;
  comments: number;
  shares: number;
}) {
  const { video_id: videoId, creator_id: creatorId, campaign_id: campaignId } = row;

  await supabase.from("video_analysis")
    .update({ status: "processing" })
    .eq("video_id", videoId)
    .eq("campaign_id", campaignId);

  // Step 1: caption analysis
  const captionResult = await analyzeCaptionWithRetry(row.caption, row.campaign_name, row.creator_handle);

  if (!captionResult) {
    await supabase.from("video_analysis").update({
      status: "failed",
      error_message: "Claude caption analysis failed after retry",
    }).eq("video_id", videoId).eq("campaign_id", campaignId);
    return;
  }

  // Step 2: transcription
  let transcript: string | null = null;
  try {
    transcript = await transcribeVideo(row.video_url, videoId);
  } catch (err: any) {
    console.error(`Transcription failed for ${videoId}:`, err.message);
  }

  if (!transcript) {
    const scores = calculateFallbackScore({
      captionScore: captionResult.authenticity_score,
      likes: row.likes, views: row.views, comments: row.comments, shares: row.shares,
    });
    await supabase.from("video_analysis").update({
      final_score: scores.finalScore,
      authenticity_score: scores.authenticityScore,
      engagement_score: scores.engagementScore,
      leaderboard_eligible: false,
      caption_result: captionResult,
      status: "completed",
      error_message: scores.ineligibleReason,
    }).eq("video_id", videoId).eq("campaign_id", campaignId);
    return;
  }

  // Step 3: keyword verification against transcript
  const keywordResult = await analyzeTranscriptForKeywordsWithRetry(
    transcript, row.required_keywords, row.campaign_name, row.creator_handle
  );

  if (!keywordResult) {
    const scores = calculateFallbackScore({
      captionScore: captionResult.authenticity_score,
      likes: row.likes, views: row.views, comments: row.comments, shares: row.shares,
    });
    await supabase.from("video_analysis").update({
      final_score: scores.finalScore,
      authenticity_score: scores.authenticityScore,
      engagement_score: scores.engagementScore,
      leaderboard_eligible: false,
      caption_result: captionResult,
      transcript_text: transcript,
      status: "completed",
      error_message: "Keyword verification failed — could not confirm required terms were spoken",
    }).eq("video_id", videoId).eq("campaign_id", campaignId);
    return;
  }

  // Step 4: final score
  const scores = calculateFinalScore({
    captionScore: captionResult.authenticity_score,
    transcriptScore: keywordResult.authenticity_score,
    allKeywordsMentioned: keywordResult.all_keywords_mentioned,
    likes: row.likes, views: row.views, comments: row.comments, shares: row.shares,
  });

  const isQuarantined = scores.engagementScore === 20;

  await supabase.from("video_analysis").update({
    final_score: scores.finalScore,
    authenticity_score: scores.authenticityScore,
    engagement_score: scores.engagementScore,
    leaderboard_eligible: isQuarantined ? false : scores.leaderboardEligible,
    caption_result: captionResult,
    transcript_result: keywordResult,
    transcript_text: transcript,
    status: isQuarantined ? "quarantined" : "completed",
    error_message: isQuarantined ? "Quarantined — suspicious engagement ratios" : scores.ineligibleReason,
  }).eq("video_id", videoId).eq("campaign_id", campaignId);

  if (scores.leaderboardEligible && !isQuarantined) {
    await updateLeaderboard(creatorId, campaignId, scores.finalScore);
  }
}

async function tick() {
  if (isRunning) return; // previous tick still running, skip this one
  isRunning = true;

  try {
    const { data: pending, error } = await supabase
      .from("video_analysis")
      .select("*")
      .eq("status", "pending")
      .limit(BATCH_SIZE);

    if (error) {
      console.error("Verification worker: failed to fetch pending rows:", error.message);
      return;
    }

    if (!pending || pending.length === 0) return;

    console.log(`Verification worker: processing ${pending.length} pending video(s)`);

    for (const row of pending) {
      try {
        await processVideo(row as any);
      } catch (err: any) {
        console.error(`Verification worker: error processing ${row.video_id}:`, err.message);
        await supabase.from("video_analysis").update({
          status: "failed",
          error_message: err.message,
        }).eq("video_id", row.video_id).eq("campaign_id", row.campaign_id);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startVerificationWorker() {
  console.log(`⚙️  Verification worker started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(tick, POLL_INTERVAL_MS);
  tick(); // run once immediately on startup too
}