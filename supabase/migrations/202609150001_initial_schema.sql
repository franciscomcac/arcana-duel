create extension if not exists pgcrypto;

create type public.match_status as enum ('waiting', 'active', 'complete', 'abandoned');

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 32),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stored_decks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  format text not null default 'casual' check (char_length(format) between 1 and 32),
  mainboard jsonb not null default '[]'::jsonb check (jsonb_typeof(mainboard) = 'array'),
  sideboard jsonb not null default '[]'::jsonb check (jsonb_typeof(sideboard) = 'array'),
  is_legal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.live_matches (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.user_profiles(id),
  guest_id uuid references public.user_profiles(id),
  winner_id uuid references public.user_profiles(id),
  status public.match_status not null default 'waiting',
  format text not null default 'casual' check (char_length(format) between 1 and 32),
  turn_number integer not null default 1 check (turn_number > 0),
  active_player uuid not null references public.user_profiles(id),
  priority_player uuid not null references public.user_profiles(id),
  phase text not null default 'precombat_main' check (phase in (
    'untap', 'upkeep', 'draw', 'precombat_main', 'begin_combat',
    'declare_attackers', 'declare_blockers', 'combat_damage',
    'end_combat', 'postcombat_main', 'end', 'cleanup'
  )),
  stack jsonb not null default '[]'::jsonb check (jsonb_typeof(stack) = 'array'),
  battlefield_state jsonb not null default '{}'::jsonb check (jsonb_typeof(battlefield_state) = 'object'),
  life_totals jsonb not null default '{}'::jsonb check (jsonb_typeof(life_totals) = 'object'),
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (guest_id is null or guest_id <> host_id),
  check (winner_id is null or winner_id = host_id or winner_id = guest_id),
  check (active_player = host_id or active_player = guest_id),
  check (priority_player = host_id or priority_player = guest_id)
);

create table public.match_events (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.live_matches(id) on delete cascade,
  actor_id uuid not null references public.user_profiles(id),
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type in (
    'move_card', 'set_tapped', 'set_counter', 'adjust_life',
    'cast_spell', 'activate_ability', 'pass_priority', 'resolve_stack',
    'advance_phase', 'declare_attacker', 'declare_blocker', 'concede', 'snapshot'
  )),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  unique (match_id, sequence)
);

create index stored_decks_owner_idx on public.stored_decks(owner_id, updated_at desc);
create index live_matches_participants_idx on public.live_matches(host_id, guest_id, status);
create index match_events_match_sequence_idx on public.match_events(match_id, sequence);

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger user_profiles_updated_at before update on public.user_profiles
for each row execute function public.set_updated_at();
create trigger stored_decks_updated_at before update on public.stored_decks
for each row execute function public.set_updated_at();
create trigger live_matches_updated_at before update on public.live_matches
for each row execute function public.set_updated_at();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Planeswalker'),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create function public.apply_match_event(
  p_match_id uuid,
  p_expected_version bigint,
  p_event_type text,
  p_payload jsonb,
  p_next_phase text default null,
  p_next_active_player uuid default null,
  p_next_priority_player uuid default null,
  p_stack jsonb default null,
  p_battlefield_state jsonb default null,
  p_life_totals jsonb default null
)
returns public.live_matches
language plpgsql
security invoker
as $$
declare
  current_match public.live_matches;
  next_match public.live_matches;
begin
  select * into current_match
  from public.live_matches
  where id = p_match_id
  for update;

  if current_match.id is null then
    raise exception 'match_not_found';
  end if;
  if auth.uid() <> current_match.host_id and auth.uid() <> current_match.guest_id then
    raise exception 'not_a_match_participant';
  end if;
  if current_match.version <> p_expected_version then
    raise exception 'stale_match_version';
  end if;
  if p_event_type not in (
    'move_card', 'set_tapped', 'set_counter', 'adjust_life',
    'cast_spell', 'activate_ability', 'pass_priority', 'resolve_stack',
    'advance_phase', 'declare_attacker', 'declare_blocker', 'concede', 'snapshot'
  ) then
    raise exception 'invalid_event_type';
  end if;

  insert into public.match_events (match_id, actor_id, sequence, event_type, payload)
  values (p_match_id, auth.uid(), current_match.version + 1, p_event_type, coalesce(p_payload, '{}'::jsonb));

  update public.live_matches
  set
    version = current_match.version + 1,
    phase = coalesce(p_next_phase, phase),
    active_player = coalesce(p_next_active_player, active_player),
    priority_player = coalesce(p_next_priority_player, priority_player),
    stack = coalesce(p_stack, stack),
    battlefield_state = coalesce(p_battlefield_state, battlefield_state),
    life_totals = coalesce(p_life_totals, life_totals)
  where id = p_match_id
  returning * into next_match;

  return next_match;
end;
$$;

alter table public.user_profiles enable row level security;
alter table public.stored_decks enable row level security;
alter table public.live_matches enable row level security;
alter table public.match_events enable row level security;

create policy "profiles are readable" on public.user_profiles for select using (true);
create policy "users update own profile" on public.user_profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "owners read decks" on public.stored_decks for select using (auth.uid() = owner_id);
create policy "owners insert decks" on public.stored_decks for insert with check (auth.uid() = owner_id);
create policy "owners update decks" on public.stored_decks for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners delete decks" on public.stored_decks for delete using (auth.uid() = owner_id);

create policy "participants read matches" on public.live_matches for select
using (auth.uid() = host_id or auth.uid() = guest_id);
create policy "hosts create matches" on public.live_matches for insert
with check (auth.uid() = host_id and auth.uid() = active_player and auth.uid() = priority_player);
create policy "participants update matches" on public.live_matches for update
using (auth.uid() = host_id or auth.uid() = guest_id)
with check (auth.uid() = host_id or auth.uid() = guest_id);

create policy "participants read events" on public.match_events for select
using (exists (
  select 1 from public.live_matches match
  where match.id = match_id and (auth.uid() = match.host_id or auth.uid() = match.guest_id)
));
create policy "participants insert events" on public.match_events for insert
with check (auth.uid() = actor_id and exists (
  select 1 from public.live_matches match
  where match.id = match_id and (auth.uid() = match.host_id or auth.uid() = match.guest_id)
));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_matches'
  ) then
    alter publication supabase_realtime add table public.live_matches;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match_events'
  ) then
    alter publication supabase_realtime add table public.match_events;
  end if;
end;
$$;
