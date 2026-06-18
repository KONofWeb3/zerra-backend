// src/inngest/client.ts
import { Inngest, EventSchemas } from "inngest";

// Defines the shape of events this app sends/receives so TypeScript
// can fully type `event.data` in function handlers without manual casting.
type VideoSyncedEvent = {
  name: "video/synced";
  data: {
    videoId: string;
    creatorId: string;
    campaignId: string | null;
    videoUrl: string;
    caption: string;
    creatorHandle: string;
    campaignName: string;
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