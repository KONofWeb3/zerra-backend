-- Smart Readiness: curated seed list + daily per-user snapshots.
-- Run in the real Supabase project (fyfwnhwpcdxcscidthst).

create table seed_accounts (
  id          uuid primary key default gen_random_uuid(),
  handle      text not null,                 -- lowercase, no @
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index seed_accounts_handle_idx on seed_accounts (handle);

create table readiness_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  snapshot_date       date not null,
  followers_total     integer not null,       -- X follower count at snapshot time
  sampled             integer not null,       -- followers actually inspected
  quality_followers   integer not null,       -- estimated across all followers
  seed_followers      integer not null,       -- seed-list accounts found in the sample
  posts_30d           integer not null,
  engagement_per_post numeric,                -- null = provider can't supply it
  score               numeric not null,
  tier                text not null,
  created_at          timestamptz not null default now(),
  unique (user_id, snapshot_date)
);

create index readiness_snapshots_user_idx on readiness_snapshots (user_id, snapshot_date desc);
