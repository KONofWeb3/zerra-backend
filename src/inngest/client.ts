// src/inngest/client.ts
import { Inngest, EventSchemas } from "inngest";

type VideoSyncedEvent = {
  name: "video/synced";
  data: {
    videoId: string;
    creatorId: string;
    campaignId: string;          // no longer nullable — every job is tied to a matched campaign
    videoUrl: string;
    caption: string;
    creatorHandle: string;
    campaignName: string;
    requiredKeywords: string[];  // keywords that MUST be confirmed spoken in the transcript
    likes: number;
    views: number;
    comments: number;
    shares: number;
  };
};

export const inngest = new Inngest({
  id: "zerra",
  schemas: new EventSchemas().fromUnion<VideoSyncedEvent>(),
});