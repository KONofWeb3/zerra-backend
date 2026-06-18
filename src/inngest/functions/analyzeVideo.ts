// src/inngest/functions/analyzeVideo.ts
import { inngest } from "../client";
import { analyzeCaptionWithRetry } from "../../lib/ai/analyzeCaption";
import { transcribeVideo } from "../../lib/ai/transcribeVideo";
import { calculateFinalScore, calculateFallbackScore } from "../../lib/ai/calculateScore";
import { supabase } from "../../lib/supabase";

// Event shape is now defined centrally in client.ts via EventSchemas,
// so `event.data` below is fully typed automatically — no casting needed.
export const analyzeVideoJob = inngest.createFunction(
  { id: "analyze-video", retries: 1 },
  { event: "video/synced" },
  async ({ event, step }) => {
    const {
      videoId, creatorId, campaignId, videoUrl, caption,
      creatorHandle, campaignName, likes, views, comments, shares,
    } = event.data;

    await step.run("mark-processing", async () => {
      await supabase.from("video_analysis").upsert(
        { video_id: videoId, creator_id: creatorId, campaign_id: campaignId, status: "processing" },
        { onConflict: "video_id" }
      );
    });

    const captionResult = await step.run("analyze-caption", async () => {
      return await analyzeCaptionWithRetry(caption, campaignName, creatorHandle);
    });

    if (!captionResult) {
      await step.run("flag-pending-review", async () => {
        await supabase.from("video_analysis").upsert(
          {
            video_id: videoId,
            creator_id: creatorId,
            campaign_id: campaignId,
            status: "failed",
            error_message: "Claude caption analysis failed after retry",
          },
          { onConflict: "video_id" }
        );
      });
      return { success: false, videoId, reason: "caption_analysis_failed" };
    }

    let transcript: string | null = null;
    let transcriptionFailed = false;

    try {
      transcript = await step.run("transcribe-video", async () => {
        return await transcribeVideo(videoUrl, videoId);
      });
    } catch (err: any) {
      console.error(`Transcription failed for video ${videoId}:`, err.message);
      transcriptionFailed = true;
    }

    if (transcriptionFailed || !transcript) {
      const scores = calculateFallbackScore({
        captionScore: captionResult.authenticity_score,
        likes, views, comments, shares,
      });

      await step.run("save-fallback-score", async () => {
        await supabase.from("video_analysis").upsert(
          {
            video_id: videoId,
            creator_id: creatorId,
            campaign_id: campaignId,
            final_score: scores.finalScore,
            authenticity_score: scores.authenticityScore,
            engagement_score: scores.engagementScore,
            leaderboard_eligible: scores.leaderboardEligible,
            caption_result: captionResult,
            transcript_result: null,
            transcript_text: null,
            status: "completed",
            error_message: "Transcription unavailable — scored on caption only",
          },
          { onConflict: "video_id" }
        );
      });

      if (scores.leaderboardEligible) {
        await step.run("update-leaderboard-fallback", async () => {
          await updateLeaderboard(creatorId, campaignId, scores.finalScore);
        });
      }

      return { success: true, videoId, finalScore: scores.finalScore, fallback: true };
    }

    const transcriptResult = await step.run("analyze-transcript", async () => {
      return await analyzeCaptionWithRetry(transcript!, campaignName, creatorHandle);
    });

    if (!transcriptResult) {
      const scores = calculateFallbackScore({
        captionScore: captionResult.authenticity_score,
        likes, views, comments, shares,
      });

      await step.run("save-fallback-score-transcript-failed", async () => {
        await supabase.from("video_analysis").upsert(
          {
            video_id: videoId,
            creator_id: creatorId,
            campaign_id: campaignId,
            final_score: scores.finalScore,
            authenticity_score: scores.authenticityScore,
            engagement_score: scores.engagementScore,
            leaderboard_eligible: scores.leaderboardEligible,
            caption_result: captionResult,
            transcript_result: null,
            transcript_text: transcript,
            status: "completed",
            error_message: "Transcript analysis failed — scored on caption only",
          },
          { onConflict: "video_id" }
        );
      });

      return { success: true, videoId, finalScore: scores.finalScore, fallback: true };
    }

    const scores = calculateFinalScore({
      captionScore: captionResult.authenticity_score,
      transcriptScore: transcriptResult.authenticity_score,
      likes, views, comments, shares,
    });

    const isQuarantined = scores.engagementScore === 20;

    await step.run("save-analysis", async () => {
      await supabase.from("video_analysis").upsert(
        {
          video_id: videoId,
          creator_id: creatorId,
          campaign_id: campaignId,
          final_score: scores.finalScore,
          authenticity_score: scores.authenticityScore,
          engagement_score: scores.engagementScore,
          leaderboard_eligible: isQuarantined ? false : scores.leaderboardEligible,
          caption_result: captionResult,
          transcript_result: transcriptResult,
          transcript_text: transcript,
          status: isQuarantined ? "quarantined" : "completed",
        },
        { onConflict: "video_id" }
      );
    });

    if (scores.leaderboardEligible && !isQuarantined) {
      await step.run("update-leaderboard", async () => {
        await updateLeaderboard(creatorId, campaignId, scores.finalScore);
      });
    }

    return { success: true, videoId, finalScore: scores.finalScore, quarantined: isQuarantined };
  }
);

async function updateLeaderboard(
  creatorId: string,
  campaignId: string | null,
  scoreIncrement: number
) {
  const { data: existing } = await supabase
    .from("leaderboard")
    .select("total_score")
    .eq("creator_id", creatorId)
    .eq("campaign_id", campaignId)
    .single();

  const newTotal = (existing?.total_score ?? 0) + scoreIncrement;

  await supabase.from("leaderboard").upsert(
    {
      creator_id: creatorId,
      campaign_id: campaignId,
      total_score: newTotal,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "creator_id,campaign_id" }
  );
}