import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import { getTwitterAccount } from "../lib/readiness/service";
import { MIN_POSTS_FOR_REPORT, buildFacts } from "../lib/intelligence/facts";
import { REPORT_MODEL, ReportError, writeReport } from "../lib/intelligence/report";

const router = Router();
router.use(requireAuth);

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // a report costs real money to write, so not on every click
const generating = new Set<string>();

// GET /intelligence/me: the latest report, and whether a new one can be written
router.get("/me", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  try {
    const [account, latest, posts] = await Promise.all([
      getTwitterAccount(user.id),
      supabase.from("creator_reports").select("id, created_at, model, facts, report").eq("user_id", user.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("x_posts").select("post_id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);
    const row = latest.data;
    const nextAt = row ? new Date(row.created_at).getTime() + COOLDOWN_MS : 0;
    res.json({
      connected: Boolean(account?.username),
      handle: account?.username ?? null,
      posts_available: posts.count ?? 0,
      min_posts: MIN_POSTS_FOR_REPORT,
      generating: generating.has(user.id),
      next_allowed_at: nextAt > Date.now() ? new Date(nextAt).toISOString() : null,
      report: row ? { id: row.id, created_at: row.created_at, facts: row.facts, analysis: row.report } : null,
    });
  } catch (err: any) {
    console.error("intelligence error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /intelligence/me/generate: calculate the facts, write the analysis, store both
router.post("/me/generate", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  if (generating.has(user.id)) { res.status(409).json({ error: "Your report is already being written" }); return; }

  const account = await getTwitterAccount(user.id);
  if (!account?.username) { res.status(400).json({ error: "Connect your X account first" }); return; }

  const { data: last } = await supabase.from("creator_reports").select("created_at").eq("user_id", user.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < COOLDOWN_MS) {
    res.status(429).json({ error: "You generated a report recently. Try again in a few hours." });
    return;
  }

  generating.add(user.id);
  try {
    const facts = await buildFacts(user.id, account.username);
    if (!facts) {
      res.status(400).json({ error: `We need at least ${MIN_POSTS_FOR_REPORT} of your posts from the last 60 days. Refresh your Smart Readiness first, then try again.` });
      return;
    }
    const analysis = await writeReport(facts);
    const { data, error } = await supabase
      .from("creator_reports")
      .insert({ user_id: user.id, model: REPORT_MODEL, facts, report: analysis })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message);
    res.json({ report: { id: data.id, created_at: data.created_at, facts, analysis } });
  } catch (err: any) {
    if (err instanceof ReportError) { res.status(502).json({ error: err.message }); return; }
    console.error("intelligence error:", err.message);
    res.status(500).json({ error: "Couldn't write your report. Try again shortly." });
  } finally {
    generating.delete(user.id);
  }
});

export default router;
