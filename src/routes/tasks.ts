import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { supabase } from "../lib/supabase";

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
  return new Set((data ?? []).map((r: { day: string }) => r.day));
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

    res.json({
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
