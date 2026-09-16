-- Hardening: pin an explicit search_path on SECURITY definer/invoker functions that didn't
-- already set one, closing the two low-severity Supabase advisor warnings for
-- public.set_updated_at() and public.apply_match_event(). Bodies are copied verbatim from
-- 202609150001_initial_schema.sql; only the added `set search_path` clause is new.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.apply_match_event(
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
set search_path = public, pg_temp
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
