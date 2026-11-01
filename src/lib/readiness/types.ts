// Data-provider boundary for Smart Readiness. The scoring code only ever sees
// these shapes, so a different source (e.g. Kaito) can replace TwitterAPI.io
// without touching anything else.

export interface FollowerLite {
  id: string;
  username: string;
  createdAt: string | null;
  followers: number;
  following: number;
  statuses: number;
  verified: boolean;
}

export interface PostLite {
  id: string;
  createdAt: string;
  isReply: boolean;
}

export interface XDataProvider {
  name: string;
  /** Up to `max` followers, newest first where the source orders them. */
  getFollowerSample(username: string, max: number): Promise<FollowerLite[]>;
  /** Original (non-reply) posts newer than `sinceMs`. */
  getRecentPosts(username: string, sinceMs: number): Promise<PostLite[]>;
}
