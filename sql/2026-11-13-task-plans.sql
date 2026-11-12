-- Creator Tasks v2: weekly plans (replies, threads, articles, posts) that are checked against the creator's X account.
-- Run in Supabase (fyfwnhwpcdxcscidthst).

create table if not exists task_plans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  kind           text not null check (kind in ('reply', 'thread', 'article', 'post')),
  per_week       int  not null check (per_week between 1 and 100),
  unit           text not null check (unit in ('weeks', 'months')),
  duration       int  not null check (duration between 1 and 52),
  start_date     date not null,          -- the creator's local day the plan started
  end_date       date not null,          -- last day of the plan (inclusive)
  tz_offset_min  int  not null default 0, -- JS getTimezoneOffset() of the creator's browser
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  archived_at    timestamptz
);
create index if not exists task_plans_user_idx on task_plans (user_id) where archived_at is null;

-- What we saw on the creator's X account (one row per tweet and kind), by their local day.
create table if not exists x_activity (
  user_id   uuid not null references users(id) on delete cascade,
  tweet_id  text not null,
  kind      text not null check (kind in ('reply', 'thread', 'article', 'post')),
  day       date not null,
  posted_at timestamptz not null,
  primary key (user_id, tweet_id, kind)
);
create index if not exists x_activity_user_day_idx on x_activity (user_id, day);
