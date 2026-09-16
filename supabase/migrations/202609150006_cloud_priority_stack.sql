-- Upgrade cloud matches from turn-at-a-time actions to explicit priority,
-- consecutive passes, phase progression, and a FILO spell stack.

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
  resolving_player jsonb;
  card jsonb;
  stack_item jsonb;
  stack_state jsonb;
  drawn jsonb;
  rebuilt_cards jsonb;
  actor_index integer;
  other_index integer;
  controller_index integer;
  card_index integer;
  stack_index integer;
  pass_count integer;
  damage integer := 0;
  delta integer := 0;
  next_turn integer;
  next_phase text;
  next_active_index integer;
  next_priority_index integer;
  next_active uuid;
  next_priority uuid;
  event_name text;
  log_text text;
  next_state jsonb;
  next_life jsonb;
begin
  if caller is null then raise exception 'authentication_required'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'invalid_action_payload'; end if;

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
  if jsonb_typeof(game -> 'players') <> 'array' or jsonb_array_length(game -> 'players') <> 2 then raise exception 'invalid_match_players'; end if;

  next_active_index := case when coalesce((game ->> 'activePlayer')::integer, 0) = 1 then 1 else 0 end;
  next_priority_index := case when coalesce((game ->> 'priorityPlayer')::integer, next_active_index) = 1 then 1 else 0 end;
  stack_state := case when jsonb_typeof(game -> 'stack') = 'array' then game -> 'stack' else '[]'::jsonb end;
  pass_count := greatest(0, coalesce((game ->> 'consecutivePasses')::integer, 0));
  player := game #> array['players', actor_index::text];
  other_player := game #> array['players', other_index::text];

  if p_action_type = 'play' then
    if next_priority_index <> actor_index then raise exception 'action_requires_priority'; end if;
    select value into card
    from jsonb_array_elements(coalesce(player -> 'hand', '[]'::jsonb)) value
    where value ->> 'uid' = p_payload ->> 'uid'
    limit 1;
    if card is null then raise exception 'card_not_in_hand'; end if;

    if card ->> 'kind' <> 'instant' and (
      next_active_index <> actor_index
      or coalesce(game ->> 'phase', 'main1') not in ('main', 'main1', 'main2')
      or jsonb_array_length(stack_state) > 0
    ) then raise exception 'sorcery_timing_required';
    end if;

    if card ->> 'kind' = 'land' and (
      coalesce((player ->> 'landsPlayedThisTurn')::integer, 0) >= 1
      or coalesce(game ->> 'phase', 'main1') not in ('main', 'main1', 'main2')
      or jsonb_array_length(stack_state) > 0
    ) then raise exception 'land_play_not_legal';
    end if;

    select coalesce(jsonb_agg(value), '[]'::jsonb) into rebuilt_cards
    from jsonb_array_elements(coalesce(player -> 'hand', '[]'::jsonb)) value
    where value ->> 'uid' <> p_payload ->> 'uid';
    player := jsonb_set(player, '{hand}', rebuilt_cards, true);

    if card ->> 'kind' = 'land' then
      player := jsonb_set(player, '{battlefield}', coalesce(player -> 'battlefield', '[]'::jsonb) || jsonb_build_array(card), true);
      player := jsonb_set(player, '{landsPlayedThisTurn}', to_jsonb(coalesce((player ->> 'landsPlayedThisTurn')::integer, 0) + 1), true);
      event_name := 'move_card';
      log_text := concat(player ->> 'name', ' played ', card ->> 'name', '.');
    else
      stack_state := stack_state || jsonb_build_array(jsonb_build_object(
        'id', concat('stack-', coalesce((game ->> 'turn')::integer, 1), '-', current_match.version + 1, '-', jsonb_array_length(stack_state)),
        'controller', actor_index,
        'card', card
      ));
      event_name := 'cast_spell';
      log_text := concat(player ->> 'name', ' cast ', card ->> 'name', '.');
    end if;
    game := jsonb_set(game, array['players', actor_index::text], player, true);
    game := jsonb_set(game, '{stack}', stack_state, true);
    game := jsonb_set(game, '{consecutivePasses}', '0'::jsonb, true);

  elsif p_action_type = 'tap' then
    select ordinality::integer - 1 into card_index
    from jsonb_array_elements(coalesce(player -> 'battlefield', '[]'::jsonb)) with ordinality as cards(value, ordinality)
    where value ->> 'uid' = p_payload ->> 'uid'
    limit 1;
    if card_index is null then raise exception 'card_not_on_battlefield'; end if;
    card := player #> array['battlefield', card_index::text];
    card := jsonb_set(card, '{tapped}', to_jsonb(not coalesce((card ->> 'tapped')::boolean, false)), true);
    player := jsonb_set(player, array['battlefield', card_index::text], card, true);
    game := jsonb_set(game, array['players', actor_index::text], player, true);
    event_name := 'set_tapped';
    log_text := concat(player ->> 'name', case when (card ->> 'tapped')::boolean then ' tapped ' else ' untapped ' end, card ->> 'name', '.');

  elsif p_action_type = 'life' then
    delta := greatest(-20, least(20, coalesce((p_payload ->> 'delta')::integer, 0)));
    player := jsonb_set(player, '{life}', to_jsonb(greatest(0, least(99, coalesce((player ->> 'life')::integer, 20) + delta))), true);
    game := jsonb_set(game, array['players', actor_index::text], player, true);
    event_name := 'adjust_life';
    log_text := concat(player ->> 'name', ' adjusted life to ', player ->> 'life', '.');

  elsif p_action_type = 'pass' then
    if next_priority_index <> actor_index then raise exception 'action_requires_priority'; end if;
    pass_count := pass_count + 1;
    event_name := 'pass_priority';
    log_text := concat(player ->> 'name', ' passed priority.');

    if pass_count < 2 then
      next_priority_index := other_index;
    else
      pass_count := 0;
      if jsonb_array_length(stack_state) > 0 then
        stack_index := jsonb_array_length(stack_state) - 1;
        stack_item := stack_state -> stack_index;
        stack_state := stack_state - stack_index;
        card := stack_item -> 'card';
        controller_index := case when coalesce((stack_item ->> 'controller')::integer, 0) = 1 then 1 else 0 end;
        resolving_player := game #> array['players', controller_index::text];
        other_index := 1 - controller_index;
        other_player := game #> array['players', other_index::text];

        if card ->> 'kind' in ('creature', 'artifact', 'enchantment', 'planeswalker', 'battle') then
          resolving_player := jsonb_set(resolving_player, '{battlefield}', coalesce(resolving_player -> 'battlefield', '[]'::jsonb) || jsonb_build_array(card), true);
        else
          resolving_player := jsonb_set(resolving_player, '{graveyard}', coalesce(resolving_player -> 'graveyard', '[]'::jsonb) || jsonb_build_array(card), true);
          damage := coalesce(nullif(substring(lower(coalesce(card ->> 'rules', '')) from 'deals?[[:space:]]+([0-9]+)[[:space:]]+damage'), '')::integer, 0);
          if damage = 0 then
            damage := case card ->> 'id' when 'lightning-bolt' then 3 when 'shock' then 2 else 0 end;
          end if;
          if damage > 0 then
            other_player := jsonb_set(other_player, '{life}', to_jsonb(greatest(0, coalesce((other_player ->> 'life')::integer, 20) - damage)), true);
          end if;
        end if;

        game := jsonb_set(game, array['players', controller_index::text], resolving_player, true);
        game := jsonb_set(game, array['players', other_index::text], other_player, true);
        game := jsonb_set(game, '{stack}', stack_state, true);
        log_text := concat(card ->> 'name', ' resolved.');
      else
        next_phase := case coalesce(game ->> 'phase', 'main1')
          when 'untap' then 'upkeep'
          when 'upkeep' then 'draw'
          when 'draw' then 'main1'
          when 'main' then 'begin_combat'
          when 'main1' then 'begin_combat'
          when 'begin_combat' then 'declare_attackers'
          when 'declare_attackers' then 'declare_blockers'
          when 'declare_blockers' then 'combat_damage'
          when 'combat_damage' then 'end_combat'
          when 'end_combat' then 'main2'
          when 'main2' then 'end'
          when 'end' then 'cleanup'
          else 'untap'
        end;

        if coalesce(game ->> 'phase', 'main1') = 'cleanup' then
          next_turn := coalesce((game ->> 'turn')::integer, 1) + 1;
          next_active_index := 1 - next_active_index;
          resolving_player := game #> array['players', next_active_index::text];
          resolving_player := jsonb_set(resolving_player, '{landsPlayedThisTurn}', '0'::jsonb, true);
          select coalesce(jsonb_agg(value || jsonb_build_object('tapped', false)), '[]'::jsonb) into rebuilt_cards
          from jsonb_array_elements(coalesce(resolving_player -> 'battlefield', '[]'::jsonb)) value;
          resolving_player := jsonb_set(resolving_player, '{battlefield}', rebuilt_cards, true);
          game := jsonb_set(game, array['players', next_active_index::text], resolving_player, true);
          game := jsonb_set(game, '{turn}', to_jsonb(next_turn), true);
        end if;

        game := jsonb_set(game, '{phase}', to_jsonb(next_phase), true);
        if next_phase = 'draw' then
          resolving_player := game #> array['players', next_active_index::text];
          drawn := resolving_player -> 'library' -> 0;
          if drawn is not null then
            resolving_player := jsonb_set(resolving_player, '{library}', (resolving_player -> 'library') - 0, true);
            resolving_player := jsonb_set(resolving_player, '{hand}', coalesce(resolving_player -> 'hand', '[]'::jsonb) || jsonb_build_array(drawn), true);
            game := jsonb_set(game, array['players', next_active_index::text], resolving_player, true);
          end if;
        end if;
        log_text := concat('Turn ', coalesce((game ->> 'turn')::integer, 1), ': ', replace(next_phase, '_', ' '), '.');
      end if;
      next_priority_index := next_active_index;
    end if;

    game := jsonb_set(game, '{activePlayer}', to_jsonb(next_active_index), true);
    game := jsonb_set(game, '{priorityPlayer}', to_jsonb(next_priority_index), true);
    game := jsonb_set(game, '{consecutivePasses}', to_jsonb(pass_count), true);

  elsif p_action_type = 'end' then
    if next_active_index <> actor_index then raise exception 'action_requires_active_player'; end if;
    next_active_index := other_index;
    next_priority_index := other_index;
    next_turn := coalesce((game ->> 'turn')::integer, 1) + 1;
    resolving_player := other_player;
    resolving_player := jsonb_set(resolving_player, '{landsPlayedThisTurn}', '0'::jsonb, true);
    select coalesce(jsonb_agg(value || jsonb_build_object('tapped', false)), '[]'::jsonb) into rebuilt_cards
    from jsonb_array_elements(coalesce(resolving_player -> 'battlefield', '[]'::jsonb)) value;
    resolving_player := jsonb_set(resolving_player, '{battlefield}', rebuilt_cards, true);
    game := jsonb_set(game, array['players', other_index::text], resolving_player, true);
    game := jsonb_set(game, '{activePlayer}', to_jsonb(next_active_index), true);
    game := jsonb_set(game, '{priorityPlayer}', to_jsonb(next_priority_index), true);
    game := jsonb_set(game, '{consecutivePasses}', '0'::jsonb, true);
    game := jsonb_set(game, '{turn}', to_jsonb(next_turn), true);
    game := jsonb_set(game, '{phase}', '"untap"'::jsonb, true);
    event_name := 'advance_phase';
    log_text := concat(resolving_player ->> 'name', ' begins turn ', next_turn, '.');

  else
    raise exception 'invalid_cloud_action';
  end if;

  game := jsonb_set(game, '{log}', coalesce(game -> 'log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'text', log_text
  )), true);
  next_state := jsonb_set(current_match.battlefield_state, '{game}', game, true);
  next_life := jsonb_build_object(
    current_match.host_id::text, coalesce((game #>> '{players,0,life}')::integer, 20),
    current_match.guest_id::text, coalesce((game #>> '{players,1,life}')::integer, 20)
  );
  next_active := case when next_active_index = 0 then current_match.host_id else current_match.guest_id end;
  next_priority := case when next_priority_index = 0 then current_match.host_id else current_match.guest_id end;

  insert into public.match_events (match_id, actor_id, sequence, event_type, payload)
  values (p_match_id, caller, current_match.version + 1, event_name, p_payload);

  update public.live_matches
  set battlefield_state = next_state,
      stack = coalesce(game -> 'stack', '[]'::jsonb),
      life_totals = next_life,
      turn_number = coalesce((game ->> 'turn')::integer, turn_number),
      active_player = next_active,
      priority_player = next_priority,
      version = current_match.version + 1
  where id = p_match_id
  returning * into next_match;
  return next_match;
exception
  when invalid_text_representation then
    raise exception 'invalid_action_scalar';
end;
$$;

revoke all on function public.apply_cloud_match_action(uuid, text, jsonb) from public, anon;
grant execute on function public.apply_cloud_match_action(uuid, text, jsonb) to authenticated;
