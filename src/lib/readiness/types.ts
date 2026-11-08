// Data-provider boundary for Smart Readiness. The scoring code only ever sees
// these shapes, so a different source can replace TwitterAPI.io without
// touching anything else.

export interface FollowerLite {
  id: string;
  username: string;
  createdAt: string | null;
  followers: number;
  following: number;
  statuses: number;
  /** Likes the account has given: a cheap "is this a real, active human" signal. */
  likes: number;
  hasBio: boolean;
  verified: boolean;
}

export interface PostLite {
  id: string;
  createdAt: string;
  isReply: boolean;
  text: string;
  likes: number;
  replies: number;
  retweets: number;
  quotes: number;
  views: number;
}

export interface RecentPosts {
  posts: PostLite[];
  /** Live follower count of the account, when the source reports it. */
  followers: number | null;
  /** The account's X display name, when the source reports it. */
  displayName: string | null;
}

export interface XDataProvider {
  name: string;
  /** Up to `max` followers, newest first where the source orders them. */
  getFollowerSample(username: string, max: number): Promise<FollowerLite[]>;
  /** Original posts newer than `sinceMs`, newest first. */
  getRecentPosts(username: string, sinceMs: number): Promise<RecentPosts>;
}
