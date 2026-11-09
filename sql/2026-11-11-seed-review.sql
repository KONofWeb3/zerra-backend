-- Credible-account review: suggested accounts are approved or rejected by an admin.
-- Existing seed rows count as approved. Run in Supabase (fyfwnhwpcdxcscidthst).

alter table seed_accounts
  add column if not exists status     text not null default 'approved' check (status in ('approved', 'rejected')),
  add column if not exists name       text,
  add column if not exists avatar     text,
  add column if not exists followers  bigint,
  add column if not exists decided_at timestamptz;
