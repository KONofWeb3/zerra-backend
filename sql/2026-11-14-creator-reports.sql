-- Creator Intelligence: stored reports (the numbers we measured plus the written analysis).
-- Run in Supabase (fyfwnhwpcdxcscidthst).

create table if not exists creator_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  model      text not null,
  facts      jsonb not null,   -- everything the analysis was based on, calculated by our code
  report     jsonb not null    -- the written analysis
);
create index if not exists creator_reports_user_idx on creator_reports (user_id, created_at desc);
