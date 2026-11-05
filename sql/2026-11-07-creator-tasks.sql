-- Creator Tasks: a personal daily checklist with a streak and an activity heatmap.
-- Run in the real Supabase project (fyfwnhwpcdxcscidthst).
--
-- A task is a recurring daily item. Ticking it records a completion for that day.
-- Deleting a task only archives it, so past activity (streak, heatmap) is kept.

create table creator_tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 120),
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

create index creator_tasks_active_idx on creator_tasks (user_id) where archived_at is null;

create table creator_task_completions (
  task_id    uuid not null references creator_tasks(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  day        date not null,            -- the user's local day, sent by the client
  created_at timestamptz not null default now(),
  primary key (task_id, day)
);

create index creator_task_completions_user_day_idx on creator_task_completions (user_id, day);
