create table if not exists public.team_logos (
  id uuid primary key default gen_random_uuid(),
  sport text not null default 'football',
  source text,
  league_name text,
  team_name text not null,
  normalized_name text not null,
  logo_url text not null,
  source_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sport, normalized_name)
);

create index if not exists team_logos_sport_normalized_name_idx
on public.team_logos (sport, normalized_name);

alter table public.team_logos enable row level security;

drop policy if exists "Team logos are readable by everyone" on public.team_logos;
create policy "Team logos are readable by everyone"
on public.team_logos
for select
to anon, authenticated
using (true);
