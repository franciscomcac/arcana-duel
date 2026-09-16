-- Keep indexed match columns consistent with the authoritative JSON snapshot.
-- This trigger also closes a match as soon as a participant loses by life total.

create or replace function public.cloud_started_state(p_state jsonb)
returns jsonb
language sql
volatile
set search_path = public
as $$
  select jsonb_set(
    p_state,
    '{game}',
    jsonb_build_object(
      'turn', 1,
      'activePlayer', 0,
      'priorityPlayer', 0,
      'phase', 'main1',
      'stack', '[]'::jsonb,
      'players', jsonb_build_array(
        p_state #> '{lobby,host,player}',
        p_state #> '{lobby,guest,player}'
      ),
      'log', jsonb_build_array(jsonb_build_object(
        'id', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
        'text', concat(p_state #>> '{lobby,host,name}', ' takes the first turn.')
      ))
    ),
    true
  );
$$;

create or replace function public.sync_cloud_match_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  game jsonb := new.battlefield_state -> 'game';
  game_phase text;
  active_index integer;
  priority_index integer;
  host_life integer;
  guest_life integer;
  declared_winner text;
begin
  if game is null or jsonb_typeof(game) <> 'object' or new.guest_id is null then
    return new;
  end if;

  if jsonb_typeof(game -> 'players') <> 'array' or jsonb_array_length(game -> 'players') <> 2 then
    raise exception 'invalid_match_players';
  end if;

  new.turn_number := greatest(1, coalesce((game ->> 'turn')::integer, new.turn_number));
  active_index := case when coalesce((game ->> 'activePlayer')::integer, 0) = 1 then 1 else 0 end;
  priority_index := case when coalesce((game ->> 'priorityPlayer')::integer, active_index) = 1 then 1 else 0 end;
  new.active_player := case when active_index = 0 then new.host_id else new.guest_id end;
  new.priority_player := case when priority_index = 0 then new.host_id else new.guest_id end;

  game_phase := coalesce(nullif(game ->> 'phase', ''), 'main1');
  new.phase := case game_phase
    when 'main' then 'precombat_main'
    when 'main1' then 'precombat_main'
    when 'main2' then 'postcombat_main'
    else game_phase
  end;

  if jsonb_typeof(game -> 'stack') = 'array' then
    new.stack := game -> 'stack';
  end if;

  host_life := coalesce((game #>> '{players,0,life}')::integer, 20);
  guest_life := coalesce((game #>> '{players,1,life}')::integer, 20);
  new.life_totals := jsonb_build_object(new.host_id::text, host_life, new.guest_id::text, guest_life);

  declared_winner := nullif(game ->> 'winnerId', '');
  if declared_winner = new.host_id::text or guest_life <= 0 then
    new.status := 'complete';
    new.winner_id := new.host_id;
  elsif declared_winner = new.guest_id::text or host_life <= 0 then
    new.status := 'complete';
    new.winner_id := new.guest_id;
  end if;

  return new;
exception
  when invalid_text_representation then
    raise exception 'invalid_match_scalar';
end;
$$;

drop trigger if exists sync_cloud_match_columns on public.live_matches;
create trigger sync_cloud_match_columns
before insert or update of battlefield_state, host_id, guest_id on public.live_matches
for each row execute function public.sync_cloud_match_columns();

revoke all on function public.cloud_started_state(jsonb) from public, anon;
revoke all on function public.sync_cloud_match_columns() from public, anon, authenticated;
