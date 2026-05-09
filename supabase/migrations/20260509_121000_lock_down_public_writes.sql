-- Lock down public Supabase writes after frontend mutations move to the backend API.
--
-- The backend uses SUPABASE_SERVICE_ROLE_KEY and can continue writing through
-- the service role. Public frontend clients should only read public data.

alter table public.comments enable row level security;
alter table public.notifications enable row level security;
alter table public.markets enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "Anyone can post a comment" on public.comments;
drop policy if exists "Authors can update their own comments" on public.comments;
drop policy if exists "Authors can delete their own comments" on public.comments;

drop policy if exists "System and creators can update markets" on public.markets;

drop policy if exists "Users can view own notifications" on public.notifications;
drop policy if exists "Users can update own notifications" on public.notifications;

drop policy if exists "Profiles are readable by everyone" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

drop policy if exists "Comments are viewable by everyone" on public.comments;
create policy "Comments are viewable by everyone"
on public.comments
for select
to anon, authenticated
using (true);

drop policy if exists "Markets are readable by everyone" on public.markets;
create policy "Markets are readable by everyone"
on public.markets
for select
to anon, authenticated
using (true);

-- No public notification policy is recreated here. Notification reads and
-- mark-read mutations should go through the backend wallet-auth API.
-- No public profile policy is recreated here either because profile rows may
-- contain private fields such as email addresses.
