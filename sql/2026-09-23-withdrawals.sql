-- New self-serve withdrawal ledger. Run in the real Supabase project
-- (fyfwnhwpcdxcscidthst), not the other one.
--
-- Ledger model (see routes/wallet.ts for the full explanation):
--   available_to_withdraw = sum(claims.reward_usdc where status IN ('approved','paid'))
--                            - sum(earnings.amount_usdc)         -- old manual payouts already sent
--                            - sum(withdrawals.amount_usdc where status IN ('pending','completed'))
-- 'paid' claims are included (not just 'approved') because status='paid' just
-- means "money already left the building via the old manual process" - the
-- earnings row it produced is subtracted right back out, so it nets to zero,
-- never double-counted, never re-surfaced as newly available.

create table withdrawals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  amount_usdc        numeric not null check (amount_usdc > 0),
  destination_address text not null,
  network            text not null default 'base',
  status             text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  tx_hash            text,
  network_fee_usdc   numeric,
  error              text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index withdrawals_user_id_idx on withdrawals(user_id);

-- A user should never have two withdrawals racing each other. The API layer
-- checks for an existing pending row before inserting, but that check-then-
-- insert has a race window on its own; this UNIQUE index is what actually
-- closes it - a second concurrent insert while one is already 'pending' is
-- rejected by Postgres itself (23505), not just discouraged by the app.
create unique index withdrawals_one_pending_per_user on withdrawals(user_id) where status = 'pending';
