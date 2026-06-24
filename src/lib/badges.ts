export interface BadgeDef {
  id: string;
  name: string;
  shortLabel: string;
  description: string;
  theme: "ember" | "violet";
  claimHeadline: string;
  claimSubtext: string;
}

export const BADGE_DEFS: BadgeDef[] = [
  {
    id: "early-creator",
    name: "Early creator badge",
    shortLabel: "Early Adopter",
    description: "This badge is only for the Day1 Creators",
    theme: "ember",
    claimHeadline: "Congratulation",
    claimSubtext: "Thank you for being here early, we have something for you soon.",
  },
  {
    id: "verified-influencer",
    name: "Influencer Badge",
    shortLabel: "Verified Influencer",
    description: "You have obtained 1.6M+ Views",
    theme: "violet",
    claimHeadline: "You're Now an Influencer",
    claimSubtext: "You have obtained 1.6M+ Views",
  },
];

// Must match the frontend's @/lib/badges FOLLOWER_THRESHOLD exactly —
// this is the server-side enforcement so a user can't claim the
// Influencer badge by calling the API directly and skipping the
// frontend's eligibility check.
export const FOLLOWER_THRESHOLD = 10000;