-- CT discovery database: per-account 30-day stats, discovery score and review status.
-- Run in Supabase (fyfwnhwpcdxcscidthst) after 2026-11-10-ct-posts.sql and 2026-11-11-seed-review.sql.

alter table ct_posts
  add column if not exists kind      text not null default 'original' check (kind in ('original', 'quote')),
  add column if not exists author_id text,
  add column if not exists keywords  text[] not null default '{}';

create table if not exists ct_accounts (
  handle           text primary key,                 -- lowercase, no @
  author_id        text,
  name             text,
  avatar           text,
  followers        bigint,
  status           text not null default 'discovered'
                   check (status in ('discovered', 'under_review', 'approved', 'rejected', 'emerging')),
  niche_primary    text,
  niche_secondary  text,
  originals        int not null default 0,
  quotes           int not null default 0,
  active_days      int not null default 0,
  median_views     bigint,
  avg_views        bigint,
  median_er        numeric,                          -- percent, null when views are unavailable
  median_likes     numeric,
  median_replies   numeric,
  median_reposts   numeric,
  median_quotes    numeric,
  discovery_score  numeric not null default 0,       -- out of 100, missing components score 0
  score_parts      jsonb not null default '{}',      -- points per component (null = unavailable)
  coverage         numeric not null default 0,       -- share of the 100 points we can measure today
  authenticity     text,                             -- High / Medium / Low
  data_confidence  text,                             -- High / Medium / Low
  sources          jsonb not null default '{}',      -- discovery keyword -> posts found
  first_seen       timestamptz not null default now(),
  last_post_at     timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists ct_accounts_rank_idx on ct_accounts (status, discovery_score desc);

create table if not exists ct_account_snapshots (
  handle           text not null,
  day              date not null,
  discovery_score  numeric not null,
  metrics          jsonb not null default '{}',
  primary key (handle, day)
);
