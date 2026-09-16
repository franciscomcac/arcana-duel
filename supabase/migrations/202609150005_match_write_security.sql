-- Realtime clients may read snapshots and events, but every write must pass
-- through a security-definer RPC that locks and validates the match row.

drop policy if exists "participants update matches" on public.live_matches;
drop policy if exists "participants insert events" on public.match_events;

revoke insert, update, delete, truncate on table public.live_matches from anon, authenticated;
revoke insert, update, delete, truncate on table public.match_events from anon, authenticated;
revoke execute on function public.apply_match_event(
  uuid, bigint, text, jsonb, text, uuid, uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated;

-- Prevent accidentally or maliciously oversized JSON snapshots from becoming
-- a realtime fan-out and storage denial of service.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'live_matches_snapshot_size'
      and conrelid = 'public.live_matches'::regclass
  ) then
    alter table public.live_matches
      add constraint live_matches_snapshot_size
      check (octet_length(battlefield_state::text) <= 4194304);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'live_matches_stack_size'
      and conrelid = 'public.live_matches'::regclass
  ) then
    alter table public.live_matches
      add constraint live_matches_stack_size
      check (jsonb_array_length(stack) <= 256);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'stored_decks_card_counts'
      and conrelid = 'public.stored_decks'::regclass
  ) then
    alter table public.stored_decks
      add constraint stored_decks_card_counts
      check (jsonb_array_length(mainboard) <= 500 and jsonb_array_length(sideboard) <= 100);
  end if;
end;
$$;

-- Reassert the intended read surface and RPC entry points explicitly.
grant select on table public.live_matches, public.match_events to authenticated;
grant execute on function public.get_cloud_lobby() to authenticated;
grant execute on function public.create_cloud_match(text, text, text, jsonb) to authenticated;
grant execute on function public.join_cloud_match(uuid, jsonb) to authenticated;
grant execute on function public.set_cloud_match_ready(uuid, boolean) to authenticated;
grant execute on function public.find_or_create_cloud_quick_match(text, jsonb) to authenticated;
grant execute on function public.leave_cloud_match(uuid) to authenticated;
grant execute on function public.apply_cloud_match_action(uuid, text, jsonb) to authenticated;
