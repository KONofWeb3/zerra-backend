// src/lib/ai/analyzeTranscriptForKeywords.ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface KeywordVerificationResult {
  authenticity_score: number;          // 0-100 — overall genuine vs scripted/fake feel
  sentiment: "Positive" | "Neutral" | "Negative" | "Mixed";
  verdict: "Authentic" | "Scripted" | "Suspicious";
  keywords_required: string[];         // echoed back from campaign for traceability
  keywords_mentioned: string[];        // which required keywords were ACTUALLY found in transcript
  all_keywords_mentioned: boolean;     // true only if every required keyword was found
  keyword_coverage: number;            // 0-100 — % of required keywords that were mentioned
  product_relevance: number;           // 0-100 — how genuinely the content discusses the product/campaign
  flags: { type: "good" | "warn" | "bad"; text: string }[];
  summary: string;
}

/**
 * Verifies a video's TRANSCRIPT (spoken audio, not caption) against a campaign's
 * required keywords. This is the core authenticity check — confirms the creator
 * actually SAID the required terms out loud, not just hashtagged them in the caption.
 */
export async function analyzeTranscriptForKeywords(
  transcript: string,
  requiredKeywords: string[],
  campaignName: string,
  creatorHandle: string
): Promise<KeywordVerificationResult> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: `You are Zerra's AI content verification engine. Your job is to verify
that a creator genuinely mentioned specific required keywords in their spoken video content,
and assess whether the mention feels authentic versus scripted/stuffed in just to game the system.

Campaign: ${campaignName}
Creator: ${creatorHandle}
Required keywords (must be confirmed as ACTUALLY SPOKEN in the transcript below): ${JSON.stringify(requiredKeywords)}

Video transcript (from speech-to-text, may contain minor transcription errors — use reasonable
judgment for near-matches, misspellings, or phonetic variants of the required keywords):
"${transcript}"

Analyze:
1. Which of the required keywords were genuinely mentioned in the spoken content (account for natural speech variations, not just exact string matches)
2. Whether the mention feels like a natural, authentic part of the content, or robotically inserted/keyword-stuffed
3. Overall sentiment and authenticity of the review/content
4. How relevant and genuine the product/campaign discussion is

Return ONLY JSON, no preamble, no markdown fences:
{
  "authenticity_score": <0-100>,
  "sentiment": "<Positive|Neutral|Negative|Mixed>",
  "verdict": "<Authentic|Scripted|Suspicious>",
  "keywords_required": ${JSON.stringify(requiredKeywords)},
  "keywords_mentioned": ["<keyword exactly as it was found or closely matched>"],
  "all_keywords_mentioned": <true only if EVERY required keyword was found>,
  "keyword_coverage": <0-100, percentage of required keywords mentioned>,
  "product_relevance": <0-100>,
  "flags": [{"type": "<good|warn|bad>", "text": "<observation>"}],
  "summary": "<2-3 sentence explanation, specifically noting which keywords were/weren't found and why>"
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
    return JSON.parse(clean) as KeywordVerificationResult;
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${clean.slice(0, 200)}`);
  }
}

export async function analyzeTranscriptForKeywordsWithRetry(
  transcript: string,
  requiredKeywords: string[],
  campaignName: string,
  creatorHandle: string
): Promise<KeywordVerificationResult | null> {
  try {
    return await analyzeTranscriptForKeywords(transcript, requiredKeywords, campaignName, creatorHandle);
  } catch (firstErr) {
    console.error("Keyword verification failed, retrying in 5s:", firstErr);
    await new Promise((r) => setTimeout(r, 5000));
    try {
      return await analyzeTranscriptForKeywords(transcript, requiredKeywords, campaignName, creatorHandle);
    } catch (secondErr) {
      console.error("Keyword verification failed again after retry:", secondErr);
      return null;
    }
  }
}