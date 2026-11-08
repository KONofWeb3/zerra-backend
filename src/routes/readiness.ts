import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/requireRole";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import { getProvider } from "../lib/readiness/providers";
import {
  ReadinessError,
  computeAndStoreReadiness,
  getSnapshots,
  getTwitterAccount,
  voicesWithRank,
} from "../lib/readiness/service";
import { ALGO_VERSION } from "../lib/readiness/score";
import { syncXProfile } from "../lib/xProfile";

const router = Router();
const REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// GET /readiness/me
router.get("/me", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  try {
    const [account, snapshots] = await Promise.all([getTwitterAccount(user.id), getSnapshots(user.id)]);
    const latest: any = snapshots[0] ?? null;
    res.json({
      available: getProvider() !== null,
      connected: !!account?.username,
      username: account?.username ?? null,
      latest,
      voices: await voicesWithRank(user.id, latest?.niches ?? null),
      trend: [...snapshots].reverse().map((s) => ({ date: s.snapshot_date, score: Number(s.score) })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /readiness/me/sync-profile: pull the connected X account's name and picture now.
// One cheap provider call, throttled per user, so the dashboard can call it freely.
const lastProfileSync = new Map<string, number>();
const PROFILE_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000;

router.post("/me/sync-profile", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const provider = getProvider();
  if (!provider) { res.json({ ok: false, reason: "unavailable" }); return; }

  const last = lastProfileSync.get(user.id) ?? 0;
  if (Date.now() - last < PROFILE_SYNC_COOLDOWN_MS) { res.json({ ok: true, skipped: true }); return; }

  try {
    const account = await getTwitterAccount(user.id);
    if (!account?.username) { res.json({ ok: false, reason: "not_connected" }); return; }
    const profile = await provider.getUserProfile(account.username);
    lastProfileSync.set(user.id, Date.now());
    await syncXProfile(user.id, { name: profile.name, avatar: profile.avatarUrl });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("sync-profile failed:", err.message);
    res.status(502).json({ error: "Couldn't reach the data provider" });
  }
});

// POST /readiness/me/refresh: compute now, at most once per cooldown window
router.post("/me/refresh", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  try {
    const [latest] = await getSnapshots(user.id, 1);
    // A snapshot from an older scoring model is recomputed straight away, whatever its age.
    const current = latest && (latest.algo_version ?? 1) >= ALGO_VERSION;
    if (current && Date.now() - new Date(latest.created_at).getTime() < REFRESH_COOLDOWN_MS) {
      res.status(429).json({ error: "Refreshed recently, try again later" });
      return;
    }
    await computeAndStoreReadiness(user.id);
    res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof ReadinessError) {
      const status = err.code === "not_connected" ? 400 : err.code === "unavailable" ? 503 : 502;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: seed list ──────────────────────────────────────────
const admin = Router();
admin.use(requireAuth, requireAdmin);

const cleanHandle = (h: string) => String(h).trim().replace(/^@/, "").toLowerCase();

admin.get("/seeds", async (_req, res: Response) => {
  const { data, error } = await supabase
    .from("seed_accounts")
    .select("id, handle, note, created_at")
    .order("handle");
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ seeds: data });
});

// POST /admin/readiness/seeds  { handles: string[] } or { handle: string }, optional note
admin.post("/seeds", async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const raw: string[] = Array.isArray(req.body.handles) ? req.body.handles : req.body.handle ? [req.body.handle] : [];
  const handles = [...new Set(raw.map(cleanHandle).filter((h) => /^[a-z0-9_]{1,15}$/.test(h)))];
  if (handles.length === 0) { res.status(400).json({ error: "No valid handles" }); return; }
  const rows = handles.map((handle) => ({ handle, note: req.body.note ?? null, created_by: user.id }));
  const { error } = await supabase.from("seed_accounts").upsert(rows, { onConflict: "handle", ignoreDuplicates: true });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ added: handles.length });
});

admin.delete("/seeds/:id", async (req, res: Response) => {
  const { error } = await supabase.from("seed_accounts").delete().eq("id", req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

export { admin as readinessAdminRouter };
export default router;
