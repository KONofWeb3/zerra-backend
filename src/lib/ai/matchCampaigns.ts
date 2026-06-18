// src/lib/ai/matchCampaigns.ts
import { supabase } from "../supabase";

export interface MatchedCampaign {
  campaignId: string;
  campaignName: string;
  matchedHashtags: string[];     // which hashtags from caption triggered eligibility
  requiredKeywords: string[];    // keywords that MUST be confirmed spoken later (transcript check)
}

/**
 * STAGE 1 — Eligibility filter (cheap, caption-only, no AI).
 * Checks if a video's CAPTION contains a campaign's required hashtag.
 * This only determines whether the video gets queued for the expensive
 * transcript+keyword verification pipeline — it does NOT confirm authenticity.
 *
 * The actual keyword verification (did they SAY the required terms) happens
 * later in analyzeTranscriptForKeywords.ts, against the audio transcript.
 */
export async function matchCampaigns(caption: string): Promise<MatchedCampaign[]> {
  const normalizedCaption = caption.toLowerCase();

  const { data: campaigns, error } = await supabase
    .from("bounties")
    .select("id, project_name, required_hashtags, required_keywords")
    .eq("status", "active");

  if (error || !campaigns) {
    console.error("Failed to fetch campaigns for matching:", error?.message);
    return [];
  }

  const matches: MatchedCampaign[] = [];

  for (const campaign of campaigns) {
    const hashtags: string[] = campaign.required_hashtags ?? [];
    const keywords: string[] = campaign.required_keywords ?? [];

    // A campaign needs at least one hashtag defined to be caption-matchable at all
    if (hashtags.length === 0) continue;

    const matchedHashtags = hashtags.filter((tag) => {
      const clean = tag.replace(/^#/, "").toLowerCase();
      return normalizedCaption.includes(`#${clean}`) || normalizedCaption.includes(clean);
    });

    if (matchedHashtags.length > 0) {
      matches.push({
        campaignId: campaign.id,
        campaignName: campaign.project_name,
        matchedHashtags,
        requiredKeywords: keywords, // passed through for the transcript-stage check
      });
    }
  }

  return matches;
}