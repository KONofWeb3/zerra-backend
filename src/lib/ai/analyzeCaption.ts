// src/lib/ai/analyzeCaption.ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface CaptionAnalysisResult {
  authenticity_score: number;       // 0-100
  sentiment: "Positive" | "Neutral" | "Negative" | "Mixed";
  verdict: "Authentic" | "Scripted" | "Suspicious";
  product_relevance: number;        // 0-100
  flags: { type: "good" | "warn" | "bad"; text: string }[];
  summary: string;
}

/**
 * Sends caption (or transcript) text to Claude for authenticity scoring.
 * Used for BOTH caption analysis and transcript analysis — same shape of input/output.
 */
export async function analyzeCaption(
  text: string,
  campaignName: string,
  creatorHandle: string
): Promise<CaptionAnalysisResult> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `You are Zerra's AI content verification engine.

Campaign: ${campaignName}
Creator: ${creatorHandle}
Content: "${text}"

Return ONLY JSON, no preamble, no markdown fences:
{
  "authenticity_score": <0-100>,
  "sentiment": "<Positive|Neutral|Negative|Mixed>",
  "verdict": "<Authentic|Scripted|Suspicious>",
  "product_relevance": <0-100>,
  "flags": [{"type": "<good|warn|bad>", "text": "<observation>"}],
  "summary": "<2-3 sentence explanation>"
}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const raw = block.text;
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean) as CaptionAnalysisResult;
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${clean.slice(0, 200)}`);
  }
}

/**
 * Retry wrapper — per spec's error handling rule:
 * "If Claude API fails — retry once after 5 seconds. If it fails again,
 *  set authenticity_score to null and flag video as pending review."
 */
export async function analyzeCaptionWithRetry(
  text: string,
  campaignName: string,
  creatorHandle: string
): Promise<CaptionAnalysisResult | null> {
  try {
    return await analyzeCaption(text, campaignName, creatorHandle);
  } catch (firstErr) {
    console.error("Claude analysis failed, retrying in 5s:", firstErr);
    await new Promise((r) => setTimeout(r, 5000));
    try {
      return await analyzeCaption(text, campaignName, creatorHandle);
    } catch (secondErr) {
      console.error("Claude analysis failed again after retry:", secondErr);
      return null; // caller sets authenticity_score to null, flags for pending review
    }
  }
}