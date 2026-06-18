// src/lib/ai/calculateScore.ts

interface ScoreInput {
  captionScore: number;        // 0-100 from Claude caption analysis
  transcriptScore: number;     // 0-100 from Claude transcript/keyword analysis
  allKeywordsMentioned: boolean; // HARD GATE — must be true to be leaderboard eligible
  likes: number;
  views: number;
  comments: number;
  shares: number;
}

interface ScoreOutput {
  finalScore: number;
  authenticityScore: number;
  engagementScore: number;
  leaderboardEligible: boolean;
  ineligibleReason?: string;
}

export function calculateFinalScore({
  captionScore,
  transcriptScore,
  allKeywordsMentioned,
  likes,
  views,
  comments,
  shares,
}: ScoreInput): ScoreOutput {
  const likeRatio = views > 0 ? likes / views : 0;
  const commentRatio = views > 0 ? comments / views : 0;

  const engagementScore =
    likeRatio > 0.3 && commentRatio < 0.001
      ? 20
      : Math.min(100, Math.round(likeRatio * 500 + commentRatio * 2000 + shares * 0.1));

  const authenticityScore = Math.round((captionScore + transcriptScore) / 2);

  const finalScore = Math.round(
    authenticityScore * 0.4 * 10 +
      engagementScore * 0.35 * 10 +
      captionScore * 0.15 * 10 +
      transcriptScore * 0.1 * 10
  );

  // HARD GATE: even a high authenticity score doesn't count if the required
  // keywords weren't actually confirmed spoken in the video. This is the
  // difference between "hashtagged it" and "actually talked about it."
  if (!allKeywordsMentioned) {
    return {
      finalScore,
      authenticityScore,
      engagementScore,
      leaderboardEligible: false,
      ineligibleReason: "Required keywords were not confirmed in the spoken content",
    };
  }

  return {
    finalScore,
    authenticityScore,
    engagementScore,
    leaderboardEligible: authenticityScore >= 60,
    ineligibleReason: authenticityScore < 60 ? "Authenticity score below 60 threshold" : undefined,
  };
}

export function calculateFallbackScore({
  captionScore,
  likes,
  views,
  comments,
  shares,
}: Omit<ScoreInput, "transcriptScore" | "allKeywordsMentioned">): ScoreOutput {
  // No transcript means we CANNOT confirm keywords were spoken — never eligible
  const result = calculateFinalScore({
    captionScore,
    transcriptScore: captionScore,
    allKeywordsMentioned: false, // can't verify without a transcript, so this always fails the gate
    likes, views, comments, shares,
  });

  return {
    ...result,
    finalScore: Math.round(result.finalScore * 0.7),
    leaderboardEligible: false,
    ineligibleReason: "Transcription unavailable — cannot confirm required keywords were spoken",
  };
}