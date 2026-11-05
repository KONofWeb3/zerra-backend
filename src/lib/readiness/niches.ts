import { ER_CURVE, interp, median } from "./score";
import type { PostLite } from "./types";

// Crypto Twitter topics a creator can be a strong voice in. A post counts toward
// a niche when its text matches any of the niche's patterns; one post can count
// toward several niches. Patterns are deliberately specific (cashtags, project
// and term names) so generic words don't pull posts into the wrong niche.
const NICHES: Record<string, RegExp> = {
  "NFTs": /\b(nfts?|opensea|blur|pudgy|azuki|bayc|mint(ed|ing)?|pfp|floor price|ordinals?|rare pepes?)\b/i,
  "AI & Agents": /\b(ai|a\.i\.|llms?|gpt|chatgpt|agents?|agentic|openai|anthropic|claude|machine learning|neural|virtuals|ai16z|bittensor|\$tao)\b/i,
  "DeFi": /\b(defi|dex(es)?|amm|liquidity|yield|staking|lending|aave|uniswap|curve|lido|pendle|tvl|perps?|hyperliquid|restaking|eigenlayer)\b/i,
  "Memecoins": /\b(memecoins?|memes?|pump\.?fun|bonk|\$pepe|\$doge|\$wif|degen|shitcoins?|dog ?coin|pepe)\b/i,
  "Bitcoin": /\b(bitcoin|btc|\$btc|satoshi|halving|lightning network|sats?|ordinals|spot etf)\b/i,
  "Ethereum": /\b(ethereum|eth|\$eth|vitalik|eip-?\d+|rollups?|danksharding|pectra|layer ?2s?|l2s?)\b/i,
  "Solana": /\b(solana|sol|\$sol|phantom|jupiter|jito|firedancer|saga)\b/i,
  "Gaming": /\b(gamefi|web3 gaming|gaming|esports|play[- ]to[- ]earn|p2e|axie|immutable|ronin|on-?chain games?)\b/i,
  "Trading & Markets": /\b(trading|traders?|leverage|leveraged|liquidations?|bullish|bearish|bull run|bear market|price action|altseason|market cap|stop[- ]loss|take[- ]profit|longs|shorts|breakout|resistance level|support level)\b/i,
  "Airdrops": /\b(airdrops?|points|farming|retrodrop|eligib(le|ility)|tge|snapshot|claim)\b/i,
  "RWA & Stablecoins": /\b(rwa|real[- ]world assets?|tokeni[sz]ed|stablecoins?|usdc|usdt|tether|circle|treasur(y|ies)|ondo|blackrock)\b/i,
  "Infrastructure": /\b(infra(structure)?|depin|oracles?|chainlink|interoperability|bridges?|modular|zk|zero[- ]knowledge|data availability|celestia|appchains?)\b/i,
  "Security": /\b(exploits?|hacks?|rug ?pull|scams?|phishing|drainer|audit(s|ed)?|security|vulnerabilit(y|ies))\b/i,
  "DAOs & Governance": /\b(dao|daos|governance|proposals?|voting|delegat(e|es|ion)|snapshot vote)\b/i,
  "Building & Founders": /\b(building in public|builders?|founders?|startups?|shipping|shipped|vcs?|funding round|seed round|series [a-c]|pre-?seed)\b/i,
};

export const NICHE_NAMES = Object.keys(NICHES);

export function classifyPost(text: string): string[] {
  return NICHE_NAMES.filter((n) => NICHES[n].test(text));
}

export interface NicheVoice {
  niche: string;
  /** 0-100: how strong this creator's voice is on the topic. */
  score: number;
  label: string;
  posts: number;
}

const LIFT_CURVE = [[0, 0], [0.5, 20], [1, 50], [2, 100]] as const;

export function voiceLabel(score: number): string {
  if (score >= 75) return "Top voice";
  if (score >= 55) return "Strong voice";
  if (score >= 35) return "Rising voice";
  return "Emerging voice";
}

const erOf = (p: PostLite) => (p.views > 0 ? (p.likes + p.replies + p.retweets + p.quotes) / p.views : null);

/**
 * Per niche: engagement on the posts about it (vs the creator's overall level),
 * and how much they actually write about it. Needs at least two posts on the
 * topic so one lucky post can't crown a niche. Strongest three, best first.
 */
export function nicheVoices(posts: PostLite[]): NicheVoice[] {
  const overall = median(posts.map(erOf).filter((x): x is number => x != null));
  const byNiche = new Map<string, PostLite[]>();
  for (const p of posts) {
    for (const n of classifyPost(p.text)) byNiche.set(n, [...(byNiche.get(n) ?? []), p]);
  }

  const out: NicheVoice[] = [];
  for (const [niche, list] of byNiche) {
    if (list.length < 2) continue;
    const er = median(list.map(erOf).filter((x): x is number => x != null));
    if (er == null) continue;
    const lift = overall && overall > 0 ? er / overall : 1;
    const score = Math.round(
      0.5 * interp(ER_CURVE, er) + 0.25 * Math.min(1, list.length / 6) * 100 + 0.25 * interp(LIFT_CURVE, lift),
    );
    out.push({ niche, score, label: voiceLabel(score), posts: list.length });
  }
  return out.sort((a, b) => b.score - a.score || b.posts - a.posts).slice(0, 5);
}
