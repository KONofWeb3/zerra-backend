// src/lib/syncTikTok.ts
//
// Fetches a creator's TikTok videos and upserts them into tiktok_posts,
// queuing AI verification for any that match an active campaign. Used by
// both the manual POST /analytics/tiktok/sync route and the automatic
// sync right after a creator connects TikTok (routes/auth.ts).

import { supabase } from "./supabase";
import { getTikTokVideos } from "./tiktok";
import { matchCampaigns } from "./ai/matchCampaigns";

export type SyncTikTokResult =
  | { ok: true; synced: number; campaignMatches: number; message?: string }
  | { ok: false; status: number; error: string };

export async function syncTikTokPosts(userId: string): Promise<SyncTikTokResult> {
  const { data: account, error: accountError } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("platform", "tiktok")
    .single();

  if (accountError || !account) {
    return { ok: false, status: 404, error: "No TikTok account connected" };
  }

  if (new Date(account.expires_at) < new Date()) {
    return { ok: false, status: 401, error: "TikTok token expired, please reconnect" };
  }

  try {
    const videos = await getTikTokVideos(account.access_token);

    if (!videos || videos.length === 0) {
      return { ok: true, synced: 0, campaignMatches: 0, message: "No videos found" };
    }

    type TikTokVideo = Awaited<ReturnType<typeof getTikTokVideos>>[number];
    const rows = videos.map((v: TikTokVideo) => {
      const totalEngagements = v.like_count + v.comment_count + v.share_count;
      const engagementRate =
        v.view_count > 0
          ? parseFloat(((totalEngagements / v.view_count) * 100).toFixed(2))
          : 0;

      return {
        user_id: userId,
        post_id: v.id,
        title: v.title,
        cover_image_url: v.cover_image_url,
        view_count: v.view_count,
        like_count: v.like_count,
        comment_count: v.comment_count,
        share_count: v.share_count,
        engagement_rate: engagementRate,
        fetched_at: new Date().toISOString(),
        created_time: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
      };
    });

    const { error: upsertError } = await supabase
      .from("tiktok_posts")
      .upsert(rows, { onConflict: "user_id,post_id" });

    if (upsertError) {
      return { ok: false, status: 500, error: upsertError.message };
    }

    let totalJobsFired = 0;

    for (const v of videos as TikTokVideo[]) {
      const caption = v.video_description || v.title || "";
      const matches = await matchCampaigns(caption);

      if (matches.length === 0) continue;

      for (const match of matches) {
        await supabase.from("video_analysis").upsert(
          {
            video_id: v.id,
            creator_id: userId,
            campaign_id: match.campaignId,
            video_url: v.embed_link,
            caption,
            creator_handle: account.username ?? "unknown",
            campaign_name: match.campaignName,
            required_keywords: match.requiredKeywords,
            likes: v.like_count,
            views: v.view_count,
            comments: v.comment_count,
            shares: v.share_count,
            status: "pending",
          },
          { onConflict: "video_id,campaign_id" }
        );
        totalJobsFired++;
      }
    }

    return { ok: true, synced: rows.length, campaignMatches: totalJobsFired, message: "Synced successfully" };
  } catch (err: any) {
    console.error("TikTok sync error:", err.message);
    return { ok: false, status: 500, error: err.message };
  }
}
