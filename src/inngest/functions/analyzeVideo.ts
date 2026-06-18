// src/inngest/functions/analyzeVideo.ts
import { inngest } from "../client";
import { analyzeCaptionWithRetry } from "../../lib/ai/analyzeCaption";
import { analyzeTranscriptForKeywordsWithRetry } from "../../lib/ai/analyzeTranscriptForKeywords";
import { transcribeVideo } from "../../lib/ai/transcribeVideo";
import { calculateFinalScore, calculateFallbackScore } from "../../lib/ai/calculateScore";
import { supabase } from "../../lib/supabase";

// Event shape defined centrally in client.ts via EventSchemas — event.data is fully typed.
export const analyzeVideoJob = inngest.createFunction(
  { id: "analyze-video", retries: 1 },
  { event: "video/synced" },
  async ({ event, step }) => {
    const {
      videoId, creatorId, campaignId, videoUrl, caption,
      creatorHandle, campaignName, requiredKeywords, likes, views, comments, shares,
    } = event.data;

    await step.run("mark-processing", async () => {
      await supabase.from("video_analysis").upsert(
        { video_id: videoId, creator_id: creatorId, campaign_id: campaignId, status: "processing" },
        { onConflict: "video_id,campaign_id" }
      );
    });

    // Step 1: Caption analysis — fast initial signal (general authenticity, no keyword check yet)
    const captionResult = await step.run("analyze-caption", async () => {
      return await analyzeCaptionWithRetry(caption, campaignName, creatorHandle);
    });

    if (!captionResult) {
      await step.run("flag-pending-review", async () => {
        await supabase.from("video_analysis").upsert(
          {
            video_id: videoId, creator_id: creatorId, campaign_id: campaignId,
            status: "failed", error_message: "Claude caption analysis failed after retry",
          },
          { onConflict: "video_id,campaign_id" }
        );
      });
      return { success: false, videoId, campaignId, reason: "caption_analysis_failed" };
    }

    // Step 2: Transcribe audio — required to confirm keywords were actually SPOKEN
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

    // No transcript = cannot confirm keywords were spoken = never leaderboard eligible
    if (transcriptionFailed || !transcript) {
      const scores = calculateFallbackScore({
        captionScore: captionResult.authenticity_score,
        likes, views, comments, shares,
      });

      await step.run("save-fallback-score", async () => {
        await supabase.from("video_analysis").upsert(
          {
            video_id: videoId, creator_id: creatorId, campaign_id: campaignId,
            final_score: scores.finalScore,
            authenticity_score: scores.authenticityScore,
            engagement_score: scores.engagementScore,
            leaderboard_eligible: false,
            caption_result: captionResult,
            transcript_result: null,
            transcript_text: null,
            status: "completed",
            error_message: scores.ineligibleReason,
          },
          { onConflict: "video_id,campaign_id" }
        );
      });

      return { success: true, videoId, campaignId, finalScore: scores.finalScore, eligible: false };
    }

    // Step 3: Verify required keywords were ACTUALLY mentioned in the transcript
    // This is the core check — caption hashtags only got the video this far,
    // now we confirm the creator genuinely talked about it.
    const keywordResult = await step.run("verify-keywords", async () => {
      return await analyzeTranscriptForKeywordsWithRetry(
        transcript!,
        requiredKeywords,
        campaignName,
        creatorHandle
      );
    });

    if (!keywordResult) {
      const scores = calculateFallbackScore({
        captionScore: captionResult.authenticity_score,
        likes, views, comments, shares,
      });

      await step.run("save-fallback-keyword-failed", async () => {
        await supabase.from("video_analysis").upsert(
          {
            video_id: videoId, creator_id: creatorId, campaign_id: campaignId,
            final_score: scores.finalScore,
            authenticity_score: scores.authenticityScore,
            engagement_score: scores.engagementScore,
            leaderboard_eligible: false,
            caption_result: captionResult,
            transcript_result: null,
            transcript_text: transcript,
            status: "completed",
            error_message: "Keyword verification failed — could not confirm required terms were spoken",
          },
          { onConflict: "video_id,campaign_id" }
        );
      });

      return { success: true, videoId, campaignId, finalScore: scores.finalScore, eligible: false };
    }

    // Step 4: Calculate final score — gated by allKeywordsMentioned
    const scores = calculateFinalScore({
      captionScore: captionResult.authenticity_score,
      transcriptScore: keywordResult.authenticity_score,
      allKeywordsMentioned: keywordResult.all_keywords_mentioned,
      likes, views, comments, shares,
    });

    const isQuarantined = scores.engagementScore === 20;

    await step.run("save-analysis", async () => {
      await supabase.from("video_analysis").upsert(
        {
          video_id: videoId, creator_id: creatorId, campaign_id: campaignId,
          final_score: scores.finalScore,
          authenticity_score: scores.authenticityScore,
          engagement_score: scores.engagementScore,
          leaderboard_eligible: isQuarantined ? false : scores.leaderboardEligible,
          caption_result: captionResult,
          transcript_result: keywordResult,
          transcript_text: transcript,
          status: isQuarantined ? "quarantined" : "completed",
          error_message: isQuarantined ? "Quarantined — suspicious engagement ratios" : scores.ineligibleReason,
        },
        { onConflict: "video_id,campaign_id" }
      );
    });

    if (scores.leaderboardEligible && !isQuarantined) {
      await step.run("update-leaderboard", async () => {
        await updateLeaderboard(creatorId, campaignId, scores.finalScore);
      });
    }

    return {
      success: true,
      videoId,
      campaignId,
      finalScore: scores.finalScore,
      eligible: scores.leaderboardEligible && !isQuarantined,
      keywordsMentioned: keywordResult.keywords_mentioned,
      allKeywordsMentioned: keywordResult.all_keywords_mentioned,
    };
  }
);

async function updateLeaderboard(creatorId: string, campaignId: string, scoreIncrement: number) {
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