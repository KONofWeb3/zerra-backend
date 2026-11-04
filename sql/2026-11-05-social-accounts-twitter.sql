-- Allow X (Twitter) connections in social_accounts. The old check constraint
-- only listed the platforms that existed when it was written, so saving a
-- twitter row failed with: violates check constraint "social_accounts_platform_check".
-- Run in the real Supabase project (fyfwnhwpcdxcscidthst).
--
-- First check nothing else is in use, so the new rule can't reject existing rows:
--   select distinct platform from social_accounts;

alter table social_accounts drop constraint social_accounts_platform_check;

alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('tiktok', 'instagram', 'twitter', 'youtube'));
