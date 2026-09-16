-- Production lobby and match RPCs. Every state-changing function locks the
-- match row and derives the acting player from auth.uid().

create or replace function public.cloud_started_state(p_state jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_set(
    p_state,
    '{game}',
    jsonb_build_object(
      'turn', 1,
      'activePlayer', 0,
      'phase', 'main',
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

create or replace function public.get_cloud_lobby()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'rooms', coalesce((
      select jsonb_agg(room_payload order by created_at)
      from (
        select
          match.created_at,
          jsonb_build_object(
            'id', match.id,
            'code', upper(left(match.id::text, 8)),
            'name', coalesce(match.battlefield_state #>> '{lobby,name}', 'Arcana table'),
            'format', match.format,
            'privacy', coalesce(match.battlefield_state #>> '{lobby,privacy}', 'Public'),
            'status', match.status,
            'players', jsonb_build_array(jsonb_build_object(
              'id', match.host_id,
              'name', coalesce(match.battlefield_state #>> '{lobby,host,name}', 'Planeswalker'),
              'deckName', coalesce(match.battlefield_state #>> '{lobby,host,deckName}', 'Deck'),
              'ready', coalesce((match.battlefield_state #>> '{lobby,host,ready}')::boolean, false)
            )),
            'spectators', 0,
            'createdAt', floor(extract(epoch from match.created_at) * 1000)::bigint
          ) as room_payload
        from public.live_matches match
        where match.status = 'waiting'
          and match.guest_id is null
          and coalesce(match.battlefield_state #>> '{lobby,privacy}', 'Public') = 'Public'
        order by match.created_at
        limit 100
      ) visible_rooms
    ), '[]'::jsonb),
    'queued', (
      select count(*)
      from public.live_matches match
      where match.status = 'waiting'
        and match.guest_id is null
        and match.battlefield_state #>> '{lobby,privacy}' = 'Matchmade'
    )
  );
$$;

create or replace function public.create_cloud_match(
  p_room_name text,
  p_format text,
  p_privacy text,
  p_host_player jsonb
)
returns public.live_matches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  normalized_player jsonb;
  initial_state jsonb;
  created_match public.live_matches;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  if p_host_player is null or jsonb_typeof(p_host_player) <> 'object' then
    raise exception 'invalid_player_payload';
  end if;
  if p_privacy not in ('Public', 'Private', 'Matchmade') then
    raise exception 'invalid_match_privacy';
  end if;

  normalized_player := p_host_player || jsonb_build_object(
    'id', caller::text,
    'ready', p_privacy = 'Matchmade',
    'player', (p_host_player -> 'player') || jsonb_build_object('id', caller::text, 'index', 0)
  );
  initial_state := jsonb_build_object(
    'lobby', jsonb_build_object(
      'name', left(coalesce(nullif(trim(p_room_name), ''), 'Arcana table'), 80),
      'privacy', p_privacy,
      'createdAt', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      'host', normalized_player,
      'guest', null
    ),
    'game', null
  );

  insert into public.live_matches (
    host_id, status, format, active_player, priority_player,
    battlefield_state, life_totals
  ) values (
    caller, 'waiting', left(coalesce(nullif(trim(p_format), ''), 'Standard'), 32), caller, caller,
    initial_state, jsonb_build_object(caller::text, 20)
  ) returning * into created_match;

  return created_match;
end;
$$;

create or replace function public.join_cloud_match(
  p_match_id uuid,
  p_guest_player jsonb
)
returns public.live_matches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  current_match public.live_matches;
  normalized_player jsonb;
  next_state jsonb;
  next_match public.live_matches;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  if p_guest_player is null or jsonb_typeof(p_guest_player) <> 'object' then
    raise exception 'invalid_player_payload';
  end if;

  select * into current_match from public.live_matches where id = p_match_id for update;
  if current_match.id is null then raise exception 'match_not_found'; end if;
  if current_match.host_id = caller then raise exception 'host_cannot_join_own_match'; end if;
  if current_match.status <> 'waiting' or current_match.guest_id is not null then
    raise exception 'match_unavailable';
  end if;
  if coalesce(current_match.battlefield_state #>> '{lobby,privacy}', 'Public') <> 'Public' then
    raise exception 'match_is_not_public';
  end if;

  normalized_player := p_guest_player || jsonb_build_object(
    'id', caller::text,
    'ready', false,
    'player', (p_guest_player -> 'player') || jsonb_build_object('id', caller::text, 'index', 1)
  );
  next_state := jsonb_set(current_match.battlefield_state, '{lobby,guest}', normalized_player, true);

  update public.live_matches
  set guest_id = caller,
      battlefield_state = next_state,
      life_totals = life_totals || jsonb_build_object(caller::text, 20),
      version = version + 1
  where id = p_match_id
  returning * into next_match;
  return next_match;
end;
$$;

create or replace function public.set_cloud_match_ready(
  p_match_id uuid,
  p_ready boolean
)
returns public.live_matches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  current_match public.live_matches;
  next_state jsonb;
  both_ready boolean;
  next_match public.live_matches;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  select * into current_match from public.live_matches where id = p_match_id for update;
  if current_match.id is null then raise exception 'match_not_found'; end if;
  if current_match.status <> 'waiting' then raise exception 'match_already_started'; end if;

  next_state := current_match.battlefield_state;
  if caller = current_match.host_id then
    next_state := jsonb_set(next_state, '{lobby,host,ready}', to_jsonb(p_ready), true);
  elsif caller = current_match.guest_id then
    next_state := jsonb_set(next_state, '{lobby,guest,ready}', to_jsonb(p_ready), true);
  else
    raise exception 'not_a_match_participant';
  end if;

  both_ready := current_match.guest_id is not null
    and coalesce((next_state #>> '{lobby,host,ready}')::boolean, false)
    and coalesce((next_state #>> '{lobby,guest,ready}')::boolean, false);
  if both_ready then next_state := public.cloud_started_state(next_state); end if;

  update public.live_matches
  set battlefield_state = next_state,
      status = case when both_ready then 'active'::public.match_status else status end,
      active_player = host_id,
      priority_player = host_id,
      version = version + 1
  where id = p_match_id
  returning * into next_match;
  return next_match;
end;
$$;

create or replace function public.find_or_create_cloud_quick_match(
  p_format text,
  p_player jsonb
)
returns public.live_matches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  current_match public.live_matches;
  normalized_player jsonb;
  next_state jsonb;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  if p_player is null or jsonb_typeof(p_player) <> 'object' then
    raise exception 'invalid_player_payload';
  end if;
  perform pg_advisory_xact_lock(hashtext('arcana-cloud-quick-match'));

  select * into current_match
  from public.live_matches match
  where match.status = 'waiting'
    and match.guest_id is null
    and match.host_id <> caller
    and match.format = left(coalesce(nullif(trim(p_format), ''), 'Standard'), 32)
    and match.battlefield_state #>> '{lobby,privacy}' = 'Matchmade'
  order by match.created_at
  limit 1
  for update;

  if current_match.id is null then
    normalized_player := p_player || jsonb_build_object(
      'id', caller::text,
      'ready', true,
      'player', (p_player -> 'player') || jsonb_build_object('id', caller::text, 'index', 0)
    );
    next_state := jsonb_build_object(
      'lobby', jsonb_build_object(
        'name', 'Quick Match',
        'privacy', 'Matchmade',
        'createdAt', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
        'host', normalized_player,
        'guest', null
      ),
      'game', null
    );
    insert into public.live_matches (
      host_id, status, format, active_player, priority_player,
      battlefield_state, life_totals
    ) values (
      caller, 'waiting', left(coalesce(nullif(trim(p_format), ''), 'Standard'), 32), caller, caller,
      next_state, jsonb_build_object(caller::text, 20)
    ) returning * into current_match;
    return current_match;
  end if;

  normalized_player := p_player || jsonb_build_object(
    'id', caller::text,
    'ready', true,
    'player', (p_player -> 'player') || jsonb_build_object('id', caller::text, 'index', 1)
  );
  next_state := jsonb_set(current_match.battlefield_state, '{lobby,guest}', normalized_player, true);
  next_state := public.cloud_started_state(next_state);

  update public.live_matches
  set guest_id = caller,
      status = 'active',
      battlefield_state = next_state,
      life_totals = life_totals || jsonb_build_object(caller::text, 20),
      version = version + 1
  where id = current_match.id
  returning * into current_match;
  return current_match;
end;
$$;

create or replace function public.leave_cloud_match(p_match_id uuid)
returns public.live_matches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  current_match public.live_matches;
  next_state jsonb;
  next_match public.live_matches;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  select * into current_match from public.live_matches where id = p_match_id for update;
  if current_match.id is null then raise exception 'match_not_found'; end if;
  if caller <> current_match.host_id and caller is distinct from current_match.guest_id then
    raise exception 'not_a_match_participant';
  end if;

  if current_match.status = 'waiting' and caller = current_match.guest_id then
    next_state := jsonb_set(current_match.battlefield_state, '{lobby,guest}', 'null'::jsonb, true);
    next_state := jsonb_set(next_state, '{lobby,host,ready}', 'false'::jsonb, true);
    update public.live_matches
    set guest_id = null,
        battlefield_state = next_state,
        life_totals = life_totals - caller::text,
        version = version + 1
    where id = p_match_id
    returning * into next_match;
  else
    update public.live_matches
    set status = 'abandoned',
        winner_id = case
          when status = 'active' and caller = host_id then guest_id
          when status = 'active' then host_id
          else winner_id
        end,
        version = version + 1
    where id = p_match_id
    returning * into next_match;
  end if;
  return next_match;
end;
$$;

create or replace function public.apply_cloud_match_action(
  p_match_id uuid,
  p_action_type text,
  p_payload jsonb default '{}'::jsonb
)
returns public.live_matches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  current_match public.live_matches;
  next_match public.live_matches;
  game jsonb;
  player jsonb;
  other_player jsonb;
  next_player jsonb;
  card jsonb;
  drawn jsonb;
  rebuilt_cards jsonb;
  actor_index integer;
  other_index integer;
  card_index integer;
  damage integer := 0;
  delta integer := 0;
  next_turn integer;
  next_active uuid;
  event_name text;
  log_text text;
  next_state jsonb;
  next_life jsonb;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  select * into current_match from public.live_matches where id = p_match_id for update;
  if current_match.id is null then raise exception 'match_not_found'; end if;
  if current_match.status <> 'active' then raise exception 'match_not_active'; end if;
  if caller = current_match.host_id then actor_index := 0;
  elsif caller = current_match.guest_id then actor_index := 1;
  else raise exception 'not_a_match_participant';
  end if;

  other_index := 1 - actor_index;
  game := current_match.battlefield_state -> 'game';
  if game is null or jsonb_typeof(game) <> 'object' then raise exception 'invalid_match_state'; end if;
  player := game #> array['players', actor_index::text];
  other_player := game #> array['players', other_index::text];
  next_active := current_match.active_player;

  if p_action_type = 'play' then
    if coalesce((game ->> 'activePlayer')::integer, -1) <> actor_index then
      raise exception 'action_requires_priority';
    end if;
    select value into card
    from jsonb_array_elements(coalesce(player -> 'hand', '[]'::jsonb)) value
    where value ->> 'uid' = p_payload ->> 'uid'
    limit 1;
    if card is null then raise exception 'card_not_in_hand'; end if;

    select coalesce(jsonb_agg(value), '[]'::jsonb) into rebuilt_cards
    from jsonb_array_elements(coalesce(player -> 'hand', '[]'::jsonb)) value
    where value ->> 'uid' <> p_payload ->> 'uid';
    player := jsonb_set(player, '{hand}', rebuilt_cards, true);

    if card ->> 'kind' = 'instant' then
      damage := case card ->> 'id' when 'lightning-bolt' then 3 when 'shock' then 2 else 0 end;
      other_player := jsonb_set(
        other_player,
        '{life}',
        to_jsonb(greatest(0, coalesce((other_player ->> 'life')::integer, 20) - damage)),
        true
      );
      player := jsonb_set(
        player,
        '{graveyard}',
        coalesce(player -> 'graveyard', '[]'::jsonb) || jsonb_build_array(card),
        true
      );
    else
      player := jsonb_set(
        player,
        '{battlefield}',
        coalesce(player -> 'battlefield', '[]'::jsonb) || jsonb_build_array(card),
        true
      );
    end if;
    game := jsonb_set(game, array['players', actor_index::text], player, true);
    game := jsonb_set(game, array['players', other_index::text], other_player, true);
    event_name := 'cast_spell';
    log_text := concat(player ->> 'name', ' played ', card ->> 'name', '.');

  elsif p_action_type = 'tap' then
    select ordinality::integer - 1 into card_index
    from jsonb_array_elements(coalesce(player -> 'battlefield', '[]'::jsonb)) with ordinality as cards(value, ordinality)
    where value ->> 'uid' = p_payload ->> 'uid'
    limit 1;
    if card_index is null then raise exception 'card_not_on_battlefield'; end if;
    card := player #> array['battlefield', card_index::text];
    card := jsonb_set(
      card,
      '{tapped}',
      to_jsonb(not coalesce((card ->> 'tapped')::boolean, false)),
      true
    );
    player := jsonb_set(player, array['battlefield', card_index::text], card, true);
    game := jsonb_set(game, array['players', actor_index::text], player, true);
    event_name := 'set_tapped';
    log_text := concat(player ->> 'name', case when (card ->> 'tapped')::boolean then ' tapped ' else ' untapped ' end, card ->> 'name', '.');

  elsif p_action_type = 'life' then
    delta := greatest(-20, least(20, coalesce((p_payload ->> 'delta')::integer, 0)));
    player := jsonb_set(
      player,
      '{life}',
      to_jsonb(greatest(0, least(99, coalesce((player ->> 'life')::integer, 20) + delta))),
      true
    );
    game := jsonb_set(game, array['players', actor_index::text], player, true);
    event_name := 'adjust_life';
    log_text := concat(player ->> 'name', ' adjusted life to ', player ->> 'life', '.');

  elsif p_action_type = 'end' then
    if coalesce((game ->> 'activePlayer')::integer, -1) <> actor_index then
      raise exception 'action_requires_priority';
    end if;
    next_player := other_player;
    select coalesce(jsonb_agg(value || jsonb_build_object('tapped', false)), '[]'::jsonb)
    into rebuilt_cards
    from jsonb_array_elements(coalesce(next_player -> 'battlefield', '[]'::jsonb)) value;
    next_player := jsonb_set(next_player, '{battlefield}', rebuilt_cards, true);
    drawn := next_player -> 'library' -> 0;
    if drawn is not null then
      next_player := jsonb_set(next_player, '{library}', (next_player -> 'library') - 0, true);
      next_player := jsonb_set(
        next_player,
        '{hand}',
        coalesce(next_player -> 'hand', '[]'::jsonb) || jsonb_build_array(drawn),
        true
      );
    end if;
    next_turn := coalesce((game ->> 'turn')::integer, 1) + 1;
    game := jsonb_set(game, array['players', other_index::text], next_player, true);
    game := jsonb_set(game, '{activePlayer}', to_jsonb(other_index), true);
    game := jsonb_set(game, '{turn}', to_jsonb(next_turn), true);
    game := jsonb_set(game, '{phase}', '"main"'::jsonb, true);
    next_active := case when other_index = 0 then current_match.host_id else current_match.guest_id end;
    event_name := 'advance_phase';
    log_text := concat(next_player ->> 'name', ' begins turn ', next_turn, '.');

  else
    raise exception 'invalid_cloud_action';
  end if;

  game := jsonb_set(
    game,
    '{log}',
    coalesce(game -> 'log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'id', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      'text', log_text
    )),
    true
  );
  next_state := jsonb_set(current_match.battlefield_state, '{game}', game, true);
  next_life := jsonb_build_object(
    current_match.host_id::text, coalesce((game #>> '{players,0,life}')::integer, 20),
    current_match.guest_id::text, coalesce((game #>> '{players,1,life}')::integer, 20)
  );

  insert into public.match_events (match_id, actor_id, sequence, event_type, payload)
  values (p_match_id, caller, current_match.version + 1, event_name, coalesce(p_payload, '{}'::jsonb));

  update public.live_matches
  set battlefield_state = next_state,
      life_totals = next_life,
      turn_number = coalesce((game ->> 'turn')::integer, turn_number),
      active_player = next_active,
      priority_player = next_active,
      version = current_match.version + 1
  where id = p_match_id
  returning * into next_match;
  return next_match;
end;
$$;

revoke all on function public.cloud_started_state(jsonb) from public, anon;
revoke all on function public.get_cloud_lobby() from public, anon;
revoke all on function public.create_cloud_match(text, text, text, jsonb) from public, anon;
revoke all on function public.join_cloud_match(uuid, jsonb) from public, anon;
revoke all on function public.set_cloud_match_ready(uuid, boolean) from public, anon;
revoke all on function public.find_or_create_cloud_quick_match(text, jsonb) from public, anon;
revoke all on function public.leave_cloud_match(uuid) from public, anon;
revoke all on function public.apply_cloud_match_action(uuid, text, jsonb) from public, anon;

grant execute on function public.get_cloud_lobby() to authenticated;
grant execute on function public.create_cloud_match(text, text, text, jsonb) to authenticated;
grant execute on function public.join_cloud_match(uuid, jsonb) to authenticated;
grant execute on function public.set_cloud_match_ready(uuid, boolean) to authenticated;
grant execute on function public.find_or_create_cloud_quick_match(text, jsonb) to authenticated;
grant execute on function public.leave_cloud_match(uuid) to authenticated;
grant execute on function public.apply_cloud_match_action(uuid, text, jsonb) to authenticated;
