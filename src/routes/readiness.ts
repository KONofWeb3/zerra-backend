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

// GET /readiness/leaderboard — public. Zerra creators ranked by their latest Smart Readiness score.
router.get("/leaderboard", async (_req, res: Response) => {
  try {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const { data: snaps, error } = await supabase
      .from("readiness_snapshots")
      .select("user_id, score, followers_total, snapshot_date, components")
      .gte("snapshot_date", since)
      .order("snapshot_date", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);

    // Latest scored snapshot per creator (older-model rows have no breakdown and are skipped).
    const latest = new Map<string, { score: number; followers: number }>();
    for (const s of snaps ?? []) {
      if (!s.components || latest.has(s.user_id)) continue;
      latest.set(s.user_id, { score: Number(s.score), followers: Number(s.followers_total) });
    }

    const ranked = [...latest.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 100);
    const ids = ranked.map(([id]) => id);
    const [{ data: users }, { data: accounts }] = ids.length
      ? await Promise.all([
          supabase.from("users").select("id, name, avatar").in("id", ids),
          supabase.from("social_accounts").select("user_id, username").eq("platform", "twitter").in("user_id", ids),
        ])
      : [{ data: [] as any[] }, { data: [] as any[] }];
    const userById = new Map((users ?? []).map((u: any) => [u.id, u]));
    const handleById = new Map((accounts ?? []).map((a: any) => [a.user_id, a.username as string | null]));

    res.json({
      total: latest.size,
      entries: ranked.map(([id, v], i) => ({
        rank: i + 1,
        name: userById.get(id)?.name ?? null,
        avatar: userById.get(id)?.avatar ?? null,
        handle: handleById.get(id) ?? null,
        score: v.score,
        followers: v.followers,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
    let current = latest && (latest.algo_version ?? 1) >= ALGO_VERSION;
    if (current) {
      // Posts not yet saved for Trending also count as "needs a run".
      const { count } = await supabase.from("x_posts").select("post_id", { count: "exact", head: true }).eq("user_id", user.id);
      if (!count) current = false;
    }
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
    .eq("status", "approved")
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

// ── Admin: CT discovery list (review queue) ───────────────────
// ct_accounts is rebuilt by the CT collector from 30 days of posts (see lib/readiness/discovery.ts).
// This returns the not-yet-decided accounts, best discovery score first, up to 3,000.
admin.get("/candidates", async (_req, res: Response) => {
  const { data: seedRows } = await supabase.from("seed_accounts").select("handle, status");
  const decidedHandles = new Set((seedRows ?? []).map((r: any) => r.handle as string));

  const approved = (seedRows ?? []).filter((r) => r.status === "approved").length;
  const rejected = (seedRows ?? []).filter((r) => r.status === "rejected").length;

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(); // inactive accounts drop off
  const out: any[] = [];
  for (let from = 0; from < 3000; from += 1000) {
    const { data, error } = await supabase
      .from("ct_accounts")
      .select("handle, name, avatar, followers, status, niche_primary, niche_secondary, originals, quotes, active_days, median_views, median_er, discovery_score, coverage, authenticity, data_confidence, last_post_at")
      .in("status", ["discovered", "emerging", "under_review"])
      .gte("last_post_at", cutoff)
      .order("discovery_score", { ascending: false })
      .range(from, from + 999);
    if (error) { res.status(500).json({ error: error.message }); return; }
    out.push(...(data ?? []).filter((c: any) => !decidedHandles.has(c.handle)));
    if (!data || data.length < 1000) break;
  }
  res.json({ candidates: out, approved, rejected });
});

// POST /admin/readiness/candidates/decide  { handle, decision: "approved" | "rejected" | "under_review", name?, avatar?, followers? }
admin.post("/candidates/decide", async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const handle = cleanHandle(req.body.handle ?? "");
  const decision = req.body.decision;
  if (!/^[a-z0-9_]{1,15}$/.test(handle) || !["approved", "rejected", "under_review"].includes(decision)) {
    res.status(400).json({ error: "Invalid handle or decision" }); return;
  }
  const { error: upErr } = await supabase.from("ct_accounts").update({ status: decision, updated_at: new Date().toISOString() }).eq("handle", handle);
  if (upErr) { res.status(500).json({ error: upErr.message }); return; }
  if (decision !== "under_review") {
    // The approved seed list is what Smart Readiness scores against.
    const { error } = await supabase.from("seed_accounts").upsert({
      handle,
      status: decision,
      name: req.body.name ?? null,
      avatar: req.body.avatar ?? null,
      followers: Number.isFinite(Number(req.body.followers)) ? Number(req.body.followers) : null,
      created_by: user.id,
      decided_at: new Date().toISOString(),
    }, { onConflict: "handle" });
    if (error) { res.status(500).json({ error: error.message }); return; }
  }
  res.json({ ok: true });
});

export { admin as readinessAdminRouter };
export default router;
