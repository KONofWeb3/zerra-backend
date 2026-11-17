// Audience interests, estimated from the bios of a sample of a creator's followers.
//
// This is an estimate, not demographics: it only sees what followers wrote about themselves,
// only in the sample we fetched, and only where the bio mentions a topic we recognise.

import { classifyPost } from "../readiness/niches";

export interface AudienceBreakdown {
  /** Followers looked at. */
  sample: number;
  /** Of those, how many have a bio at all. */
  with_bio: number;
  /** Share of the sample per interest (each follower counted once, under their first matching interest). */
  breakdown: { interest: string; pct: number }[];
}

export function audienceFromBios(bios: string[]): AudienceBreakdown | null {
  const sample = bios.length;
  if (sample < 30) return null; // too few to say anything
  const counts = new Map<string, number>();
  let withBio = 0;
  let matched = 0;
  for (const bio of bios) {
    if (!bio.trim()) continue;
    withBio++;
    const niches = classifyPost(bio);
    if (niches.length === 0) continue;
    matched++;
    counts.set(niches[0], (counts.get(niches[0]) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 6);
  const rows = top.map(([interest, n]) => ({ interest, pct: Math.round((n / sample) * 1000) / 10 }));
  const rest = sorted.slice(6).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) rows.push({ interest: "Other interests", pct: Math.round((rest / sample) * 1000) / 10 });
  const other = Math.round(((sample - matched) / sample) * 1000) / 10;
  if (other > 0) rows.push({ interest: "No clear interest in bio", pct: other });
  return { sample, with_bio: withBio, breakdown: rows };
}
