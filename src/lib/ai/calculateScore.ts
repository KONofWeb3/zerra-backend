// src/lib/ai/calculateScore.ts

interface ScoreInput {
  captionScore: number;     // 0-100 from Claude caption analysis
  transcriptScore: number;  // 0-100 from Claude transcript analysis
  likes: number;
  views: number;
  comments: number;
  shares: number;
}

interface ScoreOutput {
  finalScore: number;          // 0-1000 — leaderboard points
  authenticityScore: number;   // 0-100 — shown on creator dashboard
  engagementScore: number;     // 0-100 — real vs botted signal
  leaderboardEligible: boolean;
}

export function calculateFinalScore({
  captionScore,
  transcriptScore,
  likes,
  views,
  comments,
  shares,
}: ScoreInput): ScoreOutput {
  // Bot detection — suspicious if engagement ratios are abnormal
  const likeRatio    = views > 0 ? likes / views : 0;
  const commentRatio = views > 0 ? comments / views : 0;

  const engagementScore =
    likeRatio > 0.3 && commentRatio < 0.001
      ? 20 // suspicious: lots of likes, almost no comments = likely botted
      : Math.min(
          100,
          Math.round(likeRatio * 500 + commentRatio * 2000 + shares * 0.1)
        );

  // Authenticity — average of caption + transcript
  const authenticityScore = Math.round((captionScore + transcriptScore) / 2);

  // Final weighted score out of 1000
  const finalScore = Math.round(
    authenticityScore * 0.4 * 10 + // 40% weight — authenticity
      engagementScore * 0.35 * 10 + // 35% weight — real engagement
      captionScore * 0.15 * 10 + // 15% weight — caption quality
      transcriptScore * 0.1 * 10 // 10% weight — spoken content
  );

  return {
    finalScore,
    authenticityScore,
    engagementScore,
    leaderboardEligible: authenticityScore >= 60,
  };
}

/**
 * Fallback when transcription fails entirely.
 * Per spec: "use caption analysis only with a 0.7 multiplier on the final score."
 */
export function calculateFallbackScore({
  captionScore,
  likes,
  views,
  comments,
  shares,
}: Omit<ScoreInput, "transcriptScore">): ScoreOutput {
  const result = calculateFinalScore({
    captionScore,
    transcriptScore: captionScore, // use caption score as stand-in so the average doesn't tank it unfairly
    likes,
    views,
    comments,
    shares,
  });

  return {
    ...result,
    finalScore: Math.round(result.finalScore * 0.7),
  };
}