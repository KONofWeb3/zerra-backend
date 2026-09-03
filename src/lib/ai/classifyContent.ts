// src/lib/ai/classifyContent.ts
//
// Content-topic classification for the Analytics "Zerra Insight" and
// "Where Your Influence Fit" cards. Same Anthropic client pattern as
// analyzeCaption.ts. Uses a FIXED taxonomy — not free-text — so a post's
// topic and a campaign's topic can be compared with plain string equality
// instead of fuzzy-matching whatever wording Claude happens to pick.
//
// This is best-effort analytics enrichment, not a verification gate like
// the campaign pipeline: a failed or malformed classification falls back
// to "Other" rather than throwing, so one bad post never breaks the whole
// insights computation.

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const TOPICS = [
  "AI", "Crypto", "Finance", "Gaming", "Tech", "Business", "Education",
  "Fitness & Health", "Fashion & Beauty", "Food", "Music", "Comedy", "Lifestyle", "Other",
] as const;

export const STYLES = [
  "In-depth commentary", "Tutorial/How-to", "Quick tips", "Reaction",
  "Storytelling/Vlog", "News/Update", "Comedy/Entertainment", "Interview/Q&A",
] as const;

export type Topic = (typeof TOPICS)[number];
export type Style = (typeof STYLES)[number];

const FALLBACK: { topic: Topic; style: Style } = { topic: "Other", style: "Storytelling/Vlog" };

function parseJson(raw: string): any | null {
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

/** Classifies one TikTok post's topic + content style from its caption/title. */
export async function classifyPostContent(caption: string, title: string): Promise<{ topic: Topic; style: Style }> {
  const text = [title, caption].filter(Boolean).join(" — ").slice(0, 2000);
  if (!text.trim()) return FALLBACK;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Classify this short-video caption/title into exactly one topic and one content style from the given lists. Return ONLY JSON, no preamble, no markdown fences.

Topics: ${TOPICS.join(", ")}
Styles: ${STYLES.join(", ")}

Content: "${text}"

{"topic": "<one of the topics above, exactly as written>", "style": "<one of the styles above, exactly as written>"}`,
        },
      ],
    });

    const block = response.content[0];
    if (block.type !== "text") return FALLBACK;

    const parsed = parseJson(block.text);
    const topic = TOPICS.includes(parsed?.topic) ? (parsed.topic as Topic) : FALLBACK.topic;
    const style = STYLES.includes(parsed?.style) ? (parsed.style as Style) : FALLBACK.style;
    return { topic, style };
  } catch (err: any) {
    console.error("classifyPostContent failed, falling back to 'Other':", err.message);
    return FALLBACK;
  }
}

/** Classifies one campaign's topic from its name/description/hashtags, for creator/campaign matching. */
export async function classifyCampaignTopic(campaign: {
  project_name: string;
  description?: string | null;
  required_hashtags?: string[] | null;
}): Promise<Topic> {
  const text = [
    campaign.project_name,
    campaign.description ?? "",
    (campaign.required_hashtags ?? []).join(" "),
  ].filter(Boolean).join(" — ").slice(0, 2000);
  if (!text.trim()) return FALLBACK.topic;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `Classify this crypto/web3 campaign into exactly one topic from the given list. Return ONLY JSON, no preamble, no markdown fences.

Topics: ${TOPICS.join(", ")}

Campaign: "${text}"

{"topic": "<one of the topics above, exactly as written>"}`,
        },
      ],
    });

    const block = response.content[0];
    if (block.type !== "text") return FALLBACK.topic;

    const parsed = parseJson(block.text);
    return TOPICS.includes(parsed?.topic) ? (parsed.topic as Topic) : FALLBACK.topic;
  } catch (err: any) {
    console.error("classifyCampaignTopic failed, falling back to 'Other':", err.message);
    return FALLBACK.topic;
  }
}
