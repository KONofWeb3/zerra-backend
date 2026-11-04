import crypto from "crypto";

// Pending X (Twitter) OAuth handshakes, kept on the server. X caps the `state`
// parameter at 500 characters, so `state` is just a random id and everything
// else (who is connecting, the PKCE verifier) stays here, out of the URL.
// In-memory is enough for a single Render instance: an entry only lives for the
// few seconds between the redirect to X and its callback, and a restart in that
// window just makes the user click Connect again.

interface Pending {
  userId: string;
  codeVerifier: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, Pending>();

function sweep() {
  const now = Date.now();
  for (const [id, p] of pending) if (p.expiresAt < now) pending.delete(id);
}

export function createTwitterState(userId: string, codeVerifier: string): string {
  sweep();
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, { userId, codeVerifier, expiresAt: Date.now() + TTL_MS });
  return state;
}

/** One use only: the entry is removed as it is read. */
export function consumeTwitterState(state: string): { userId: string; codeVerifier: string } | null {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expiresAt < Date.now()) return null;
  return { userId: p.userId, codeVerifier: p.codeVerifier };
}
