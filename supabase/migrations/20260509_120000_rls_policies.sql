-- DarkONNET Supabase RLS policies.
--
-- This migration records the current policy shape exported from Supabase for:
-- comments, notifications, markets, and profiles.
--
-- Important:
-- - The backend uses SUPABASE_SERVICE_ROLE_KEY, so backend reads/writes bypass RLS.
-- - Several policies below intentionally remain broad because the current frontend
--   still writes directly to Supabase with the public client.
-- - Treat the broad INSERT/UPDATE/ALL policies as temporary until those writes move
--   behind the backend wallet-auth/session API.

alter table public.comments enable row level security;
alter table public.notifications enable row level security;
alter table public.markets enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "Comments are viewable by everyone" on public.comments;
create policy "Comments are viewable by everyone"
on public.comments
for select
to public
using (true);

drop policy if exists "Anyone can post a comment" on public.comments;
create policy "Anyone can post a comment"
on public.comments
for insert
to public
with check (true);

drop policy if exists "Authors can update their own comments" on public.comments;
create policy "Authors can update their own comments"
on public.comments
for update
to public
using (
  wallet_address = (current_setting('request.jwt.claims', true)::json ->> 'wallet_address')
  or wallet_address = (current_setting('request.headers', true)::json ->> 'x-wallet-address')
);

drop policy if exists "Authors can delete their own comments" on public.comments;
create policy "Authors can delete their own comments"
on public.comments
for delete
to public
using (
  wallet_address = (current_setting('request.jwt.claims', true)::json ->> 'wallet_address')
);

drop policy if exists "Markets are readable by everyone" on public.markets;
create policy "Markets are readable by everyone"
on public.markets
for select
to public
using (true);

-- Temporary broad policy. Current frontend code directly upserts/updates markets.
-- Tighten this once market mutation goes through backend admin/wallet auth only.
drop policy if exists "System and creators can update markets" on public.markets;
create policy "System and creators can update markets"
on public.markets
for all
to public
using (true)
with check (true);

drop policy if exists "Users can view own notifications" on public.notifications;
create policy "Users can view own notifications"
on public.notifications
for select
to public
using (
  wallet_address = (current_setting('request.jwt.claims', true)::json ->> 'wallet_address')
);

drop policy if exists "Users can update own notifications" on public.notifications;
create policy "Users can update own notifications"
on public.notifications
for update
to public
using (
  wallet_address = (current_setting('request.jwt.claims', true)::json ->> 'wallet_address')
);

drop policy if exists "Profiles are readable by everyone" on public.profiles;
create policy "Profiles are readable by everyone"
on public.profiles
for select
to public
using (true);

-- Temporary broad policy. Current frontend code directly creates profiles.
-- Tighten this once profile mutation goes through backend wallet auth only.
drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
on public.profiles
for insert
to public
with check (true);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles
for update
to public
using (
  wallet_address = (current_setting('request.jwt.claims', true)::json ->> 'wallet_address')
)
with check (
  wallet_address = (current_setting('request.jwt.claims', true)::json ->> 'wallet_address')
);
