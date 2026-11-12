import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";
import { getTwitterAccount } from "../lib/readiness/service";
import { isSyncing, syncIfStale } from "../lib/tasksSync";

const router = Router();
router.use(requireAuth);

const MAX_ACTIVE_TASKS = 30;
const DAY_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Days are the user's own local calendar days, sent by the client as YYYY-MM-DD,
// so a streak doesn't break because the server is in a different timezone.
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => toYmd(toMs(ymd) + n * DAY_MS);
const validDay = (v: unknown): v is string => typeof v === "string" && YMD.test(v) && !Number.isNaN(toMs(v));

/** A day counts toward the streak when at least one task was completed on it. */
function currentStreak(active: Set<string>, today: string): number {
  let day = active.has(today) ? today : addDays(today, -1); // today isn't a miss until it's over
  let n = 0;
  while (active.has(day)) { n++; day = addDays(day, -1); }
  return n;
}

// The strip in the design runs Saturday to Friday.
function weekStart(today: string): string {
  const dow = new Date(toMs(today)).getUTCDay(); // 0 = Sunday ... 6 = Saturday
  return addDays(today, -((dow + 1) % 7));
}

async function activeDays(userId: string, from: string, to: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("creator_task_completions")
    .select("day")
    .eq("user_id", userId)
    .gte("day", from)
    .lte("day", to)
    .limit(20000);
  if (error) throw new Error(error.message);
  const days = new Set((data ?? []).map((r: { day: string }) => r.day));
  for (const d of await planDays(userId, from, to)) days.add(d);
  return days;
}

/** Days with at least one tweet that counts toward one of the user's plans (inside that plan's dates). */
async function planDays(userId: string, from: string, to: string): Promise<Set<string>> {
  const { data: plans } = await supabase.from("task_plans").select("kind, start_date, end_date").eq("user_id", userId).is("archived_at", null);
  const out = new Set<string>();
  if (!plans || plans.length === 0) return out;
  const { data: acts } = await supabase
    .from("x_activity").select("kind, day").eq("user_id", userId).gte("day", from).lte("day", to).limit(20000);
  for (const a of acts ?? []) {
    if (plans.some((p: any) => p.kind === a.kind && a.day >= p.start_date && a.day <= p.end_date)) out.add(a.day);
  }
  return out;
}

const KINDS = ["reply", "thread", "article", "post"] as const;
const MAX_PLANS = 8;

function addMonths(ymd: string, n: number): string {
  const d = new Date(toMs(ymd));
  d.setUTCMonth(d.getUTCMonth() + n);
  return toYmd(d.getTime());
}

/** Progress for each active plan: this week's count against the weekly target, and how many weeks were met. */
async function planStates(userId: string, today: string) {
  const { data: plans, error } = await supabase
    .from("task_plans")
    .select("id, kind, per_week, unit, duration, start_date, end_date, last_synced_at")
    .eq("user_id", userId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!plans || plans.length === 0) return { plans: [], lastSynced: [] as (string | null)[] };

  const from = plans.reduce((m: string, p: any) => (p.start_date < m ? p.start_date : m), plans[0].start_date);
  const { data: acts } = await supabase
    .from("x_activity").select("kind, day").eq("user_id", userId).gte("day", from).lte("day", today).limit(20000);

  const states = plans.map((p: any) => {
    const totalWeeks = Math.ceil(((toMs(p.end_date) - toMs(p.start_date)) / DAY_MS + 1) / 7);
    const ended = toMs(today) > toMs(p.end_date);
    const notStarted = toMs(today) < toMs(p.start_date);
    const idx = ended ? totalWeeks - 1 : Math.max(0, Math.floor((toMs(today) - toMs(p.start_date)) / (7 * DAY_MS)));
    const countIn = (a: string, b: string) =>
      (acts ?? []).filter((x: any) => x.kind === p.kind && x.day >= a && x.day <= b && x.day >= p.start_date && x.day <= p.end_date).length;
    let weeksMet = 0;
    for (let w = 0; w <= idx; w++) {
      const a = addDays(p.start_date, w * 7);
      if (countIn(a, addDays(a, 6)) >= p.per_week) weeksMet++;
    }
    const weekFrom = addDays(p.start_date, idx * 7);
    return {
      id: p.id, kind: p.kind, per_week: p.per_week, unit: p.unit, duration: p.duration,
      start_date: p.start_date, end_date: p.end_date,
      week_index: idx + 1, total_weeks: totalWeeks,
      this_week: notStarted ? 0 : countIn(weekFrom, addDays(weekFrom, 6)),
      weeks_met: weeksMet, ended,
    };
  });
  return { plans: states, lastSynced: plans.map((p: any) => p.last_synced_at as string | null) };
}

// GET /tasks?today=YYYY-MM-DD
router.get("/", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const today = req.query.today;
  if (!validDay(today)) { res.status(400).json({ error: "today (YYYY-MM-DD) is required" }); return; }

  try {
    const { data: tasks, error } = await supabase
      .from("creator_tasks")
      .select("id, title, created_at")
      .eq("user_id", user.id)
      .is("archived_at", null)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const ids = (tasks ?? []).map((t) => t.id);
    const doneToday = new Set<string>();
    if (ids.length) {
      const { data: done } = await supabase
        .from("creator_task_completions")
        .select("task_id")
        .eq("user_id", user.id)
        .eq("day", today)
        .in("task_id", ids);
      for (const d of done ?? []) doneToday.add(d.task_id);
    }

    const days = await activeDays(user.id, addDays(today, -400), today);
    const start = weekStart(today);
    const week = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return { date, active: days.has(date), future: toMs(date) > toMs(today), today: date === today };
    });

    const tz = Number.isFinite(Number(req.query.tz)) ? Number(req.query.tz) : 0;
    const { plans, lastSynced } = await planStates(user.id, today);
    const activePlans = plans.filter((p) => !p.ended);
    if (activePlans.length) syncIfStale(user.id, tz, lastSynced); // runs in the background; the page re-checks shortly

    res.json({
      plans,
      syncing: isSyncing(user.id),
      tasks: (tasks ?? []).map((t) => ({ id: t.id, title: t.title, done: doneToday.has(t.id) })),
      done: doneToday.size,
      total: ids.length,
      streak: currentStreak(days, today),
      week,
    });
  } catch (err: any) {
    console.error("tasks error:", err.message); res.status(500).json({ error: err.message });
  }
});

// GET /tasks/activity?from=YYYY-MM-DD&to=YYYY-MM-DD: days with at least one completion
router.get("/activity", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const { from, to } = req.query;
  if (!validDay(from) || !validDay(to) || toMs(to) < toMs(from) || toMs(to) - toMs(from) > 400 * DAY_MS) {
    res.status(400).json({ error: "valid from and to (YYYY-MM-DD, at most 400 days apart) are required" });
    return;
  }
  try {
    res.json({ days: [...(await activeDays(user.id, from, to))].sort() });
  } catch (err: any) {
    console.error("tasks error:", err.message); res.status(500).json({ error: err.message });
  }
});

// POST /tasks/plans { kind, per_week, unit, duration, today, tz }
router.post("/plans", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const { kind, unit } = req.body ?? {};
  const perWeek = Number(req.body?.per_week);
  const duration = Number(req.body?.duration);
  const tz = Number.isFinite(Number(req.body?.tz)) ? Math.round(Number(req.body.tz)) : 0;
  const today = req.body?.today;
  if (!KINDS.includes(kind)) { res.status(400).json({ error: "Pick replies, threads, articles or posts" }); return; }
  if (!Number.isInteger(perWeek) || perWeek < 1 || perWeek > 100) { res.status(400).json({ error: "Pick 1 to 100 per week" }); return; }
  if (unit !== "weeks" && unit !== "months") { res.status(400).json({ error: "Time frame must be weeks or months" }); return; }
  if (!Number.isInteger(duration) || duration < 1 || duration > (unit === "weeks" ? 52 : 12)) { res.status(400).json({ error: "That time frame is too long" }); return; }
  if (!validDay(today)) { res.status(400).json({ error: "today (YYYY-MM-DD) is required" }); return; }

  const account = await getTwitterAccount(user.id);
  if (!account?.username) { res.status(400).json({ error: "Connect your X account first so we can check your tasks" }); return; }

  const { data: existing } = await supabase.from("task_plans").select("id, kind, end_date").eq("user_id", user.id).is("archived_at", null);
  const live = (existing ?? []).filter((p: any) => p.end_date >= today);
  if (live.length >= MAX_PLANS) { res.status(400).json({ error: `You can run up to ${MAX_PLANS} plans at once` }); return; }
  if (live.some((p: any) => p.kind === kind)) { res.status(400).json({ error: "You already have a plan for that. Remove it first to change it." }); return; }

  const end = unit === "weeks" ? addDays(today, duration * 7 - 1) : addDays(addMonths(today, duration), -1);
  const { data, error } = await supabase
    .from("task_plans")
    .insert({ user_id: user.id, kind, per_week: perWeek, unit, duration, start_date: today, end_date: end, tz_offset_min: tz })
    .select("id")
    .single();
  if (error) { console.error("tasks error:", error.message); res.status(500).json({ error: error.message }); return; }
  syncIfStale(user.id, tz, [null]);
  res.json({ id: data.id });
});

// DELETE /tasks/plans/:id: stops the plan; what it already lit up is kept only while the plan exists
router.delete("/plans/:id", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const { error } = await supabase
    .from("task_plans").update({ archived_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", user.id);
  if (error) { console.error("tasks error:", error.message); res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// POST /tasks { title }
router.post("/", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const title = String(req.body?.title ?? "").trim();
  if (title.length < 1 || title.length > 120) { res.status(400).json({ error: "Title must be 1-120 characters" }); return; }

  const { count } = await supabase
    .from("creator_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("archived_at", null);
  if ((count ?? 0) >= MAX_ACTIVE_TASKS) { res.status(400).json({ error: `You can have up to ${MAX_ACTIVE_TASKS} tasks` }); return; }

  const { data, error } = await supabase
    .from("creator_tasks")
    .insert({ user_id: user.id, title })
    .select("id, title")
    .single();
  if (error) { console.error("tasks error:", error.message); res.status(500).json({ error: error.message }); return; }
  res.json({ task: { ...data, done: false } });
});

// POST /tasks/:id/toggle { day }: tick or untick a task for one day
router.post("/:id/toggle", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const day = req.body?.day;
  if (!validDay(day)) { res.status(400).json({ error: "day (YYYY-MM-DD) is required" }); return; }
  // A little slack for timezones ahead of UTC, but no ticking days in the future.
  if (toMs(day) > Date.now() + 2 * DAY_MS) { res.status(400).json({ error: "That day hasn't happened yet" }); return; }

  const { data: task } = await supabase
    .from("creator_tasks")
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", user.id)
    .is("archived_at", null)
    .maybeSingle();
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }

  const { data: existing } = await supabase
    .from("creator_task_completions")
    .select("task_id")
    .eq("task_id", task.id)
    .eq("day", day)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from("creator_task_completions").delete().eq("task_id", task.id).eq("day", day);
    if (error) { console.error("tasks error:", error.message); res.status(500).json({ error: error.message }); return; }
    res.json({ done: false });
  } else {
    const { error } = await supabase.from("creator_task_completions").insert({ task_id: task.id, user_id: user.id, day });
    if (error) { console.error("tasks error:", error.message); res.status(500).json({ error: error.message }); return; }
    res.json({ done: true });
  }
});

// DELETE /tasks/:id: archives the task so past activity (streak, heatmap) is kept
router.delete("/:id", async (req, res: Response) => {
  const user = (req as unknown as AuthRequest).user;
  const { error } = await supabase
    .from("creator_tasks")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", user.id);
  if (error) { console.error("tasks error:", error.message); res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

export default router;
