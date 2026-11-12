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
  /** The account's X display name and profile picture, when the source reports them. */
  displayName: string | null;
  avatarUrl: string | null;
}

/** A post found by searching X (not tied to a Zerra user). */
export interface CtPost {
  id: string;
  text: string;
  createdAt: string;
  likes: number;
  replies: number;
  retweets: number;
  quotes: number;
  views: number;
  handle: string;
  name: string | null;
  avatar: string | null;
  followers: number | null;
  kind: "original" | "quote";
  authorId: string | null;
}

export interface XDataProvider {
  name: string;
  /** The most popular original posts matching an X search query (Top results, up to `pages` pages of 20). */
  searchPosts(query: string, pages?: number): Promise<CtPost[]>;
  /** Accounts matching a name or handle (for type-ahead suggestions). */
  searchUsers(query: string): Promise<{ handle: string; name: string | null; avatar: string | null; followers: number | null; verified: boolean }[]>;
  /** Name, picture and follower count straight from the account's profile (one cheap call). */
  getUserProfile(username: string): Promise<{ name: string | null; avatarUrl: string | null; followers: number | null }>;
  /** Up to `max` followers, newest first where the source orders them. */
  getFollowerSample(username: string, max: number): Promise<FollowerLite[]>;
  /** Original posts newer than `sinceMs`, newest first. */
  getRecentPosts(username: string, sinceMs: number): Promise<RecentPosts>;
}
