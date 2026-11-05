-- Smart Readiness scoring v2: per-component breakdown, raw metrics and the
-- creator's strongest niches are stored with each daily snapshot.
-- Run in the real Supabase project (fyfwnhwpcdxcscidthst).
-- Snapshots written by the old model keep algo_version = 1 and are recomputed
-- the next time their owner opens the page.

alter table readiness_snapshots
  add column algo_version int not null default 1,
  add column components   jsonb,
  add column metrics      jsonb,
  add column niches       jsonb;
