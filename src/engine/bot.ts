import { canPayMana, checkAction, gameReducer, getManaProduction, getPower, getToughness, matchesTargetRestriction } from './game'
import type {
  CardInstance,
  CardInstanceId,
  EffectTarget,
  EngineEffect,
  GameAction,
  GameState,
  ManaColor,
  ManaPool,
  PlayerId,
  TargetRef,
} from './types'

const COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

export interface BotDecision {
  action: GameAction
  reason: string
}

export interface BotRunResult {
  state: GameState
  actions: GameAction[]
  stoppedBecause: 'opponent_priority' | 'game_over' | 'no_action' | 'limit'
}

function byCardValue(state: GameState, leftId: CardInstanceId, rightId: CardInstanceId): number {
  const left = state.cards[leftId]
  const right = state.cards[rightId]
  const valueDifference = cardValue(right) - cardValue(left)
  return valueDifference || left.name.localeCompare(right.name) || leftId.localeCompare(rightId)
}

function cardValue(card: CardInstance): number {
  return (card.manaValue ?? 0) * 3 + getPower(card) * 2 + getToughness(card) + (card.effects?.length ?? 0) * 2
}

function isAlivePermanent(state: GameState, cardId: CardInstanceId): boolean {
  return Object.values(state.players).some((player) => player.zones.battlefield.includes(cardId))
}

function opponentIds(state: GameState, playerId: PlayerId): PlayerId[] {
  return state.playerOrder.filter((id) => id !== playerId && !state.players[id].lost)
}

function enemyPermanents(state: GameState, playerId: PlayerId): CardInstanceId[] {
  return opponentIds(state, playerId)
    .flatMap((id) => state.players[id].zones.battlefield)
    .filter((id) => isAlivePermanent(state, id))
    .sort((left, right) => byCardValue(state, left, right))
}

function friendlyPermanents(state: GameState, playerId: PlayerId): CardInstanceId[] {
  return [...state.players[playerId].zones.battlefield]
    .filter((id) => isAlivePermanent(state, id))
    .sort((left, right) => byCardValue(state, left, right))
}

function targetForEffect(state: GameState, playerId: PlayerId, effect: EngineEffect): TargetRef | null {
  const opponents = opponentIds(state, playerId)
  const restriction = 'target' in effect && effect.target.kind === 'target-slot' ? effect.target.restriction : undefined
  const legal = (target: TargetRef): boolean => matchesTargetRestriction(state, target, restriction, playerId)
  if ('target' in effect && effect.type === 'counter_stack_item') {
    const target = [...state.stack].reverse().find((item) => item.controllerId !== playerId && item.counterable && legal({ kind: 'stack', stackItemId: item.id }))
    return target ? { kind: 'stack', stackItemId: target.id } : null
  }
  if (!('target' in effect)) return null
  if (effect.type === 'modify_stats' || effect.type === 'untap' || effect.type === 'add_counter') {
    const permanent = friendlyPermanents(state, playerId).find((cardId) => legal({ kind: 'permanent', cardId }))
    return permanent ? { kind: 'permanent', cardId: permanent } : null
  }
  if (effect.type === 'remove_counter') {
    const permanent = enemyPermanents(state, playerId).find((id) => legal({ kind: 'permanent', cardId: id }) && Object.values(state.cards[id].counters).some((amount) => amount > 0))
    return permanent ? { kind: 'permanent', cardId: permanent } : null
  }
  if (effect.type === 'tap' || effect.type === 'destroy' || effect.type === 'exile' || effect.type === 'return_to_hand') {
    const permanent = enemyPermanents(state, playerId).find((cardId) => legal({ kind: 'permanent', cardId }))
    return permanent ? { kind: 'permanent', cardId: permanent } : null
  }
  if (effect.type === 'damage') {
    const lethalCreature = enemyPermanents(state, playerId).find((id) => {
      const card = state.cards[id]
      return legal({ kind: 'permanent', cardId: id }) && card.types.includes('creature') && getToughness(card) - card.damageMarked <= effect.amount
    })
    if (lethalCreature) return { kind: 'permanent', cardId: lethalCreature }
    const opponent = opponents.find((opponentId) => legal({ kind: 'player', playerId: opponentId }))
    return opponent ? { kind: 'player', playerId: opponent } : null
  }
  const opponent = opponents.find((opponentId) => legal({ kind: 'player', playerId: opponentId }))
  return opponent ? { kind: 'player', playerId: opponent } : null
}

function requiredTargetCount(effects: EngineEffect[]): number {
  let count = 0
  for (const effect of effects) {
    if (!('target' in effect)) continue
    const target = effect.target as EffectTarget
    if (target.kind === 'target-slot') count = Math.max(count, target.index + 1)
  }
  return count
}

export function chooseTargets(state: GameState, playerId: PlayerId, effects: EngineEffect[]): TargetRef[] | null {
  const result: TargetRef[] = Array.from({ length: requiredTargetCount(effects) })
  for (const effect of effects) {
    if (!('target' in effect) || effect.target.kind !== 'target-slot') continue
    const chosen = targetForEffect(state, playerId, effect)
    if (!chosen) return null
    result[effect.target.index] = chosen
  }
  return result.every(Boolean) ? result : null
}

function castCandidates(state: GameState, playerId: PlayerId, usePotentialMana: boolean): Array<{ action: GameAction; card: CardInstance }> {
  const player = state.players[playerId]
  return player.zones.hand
    .map((id) => state.cards[id])
    .filter((card) => !card.types.includes('land'))
    .map((card) => {
      const targets = chooseTargets(state, playerId, card.effects ?? [])
      const needsTargets = requiredTargetCount(card.effects ?? []) > 0
      return {
        card,
        action: { type: 'CAST_SPELL', playerId, cardId: card.instanceId, targets: targets ?? undefined } as GameAction,
        targetsAvailable: !needsTargets || targets !== null,
      }
    })
    .filter(({ card, action, targetsAvailable }) => {
      if (!targetsAvailable || (usePotentialMana ? !canEventuallyPay(state, playerId, card.manaCost) : !canPayMana(player.manaPool, card.manaCost))) return false
      if (usePotentialMana) {
        const instantTiming = card.types.includes('instant') || (card.keywords ?? []).includes('flash')
        return instantTiming || (playerId === state.activePlayerId && ['main1', 'main2'].includes(state.phase) && !state.stack.length)
      }
      return checkAction(state, action).legal
    })
    .sort((left, right) => cardValue(right.card) - cardValue(left.card) || left.card.name.localeCompare(right.card.name))
}

function chooseManaAction(state: GameState, playerId: PlayerId, card: CardInstance): GameAction | null {
  const player = state.players[playerId]
  if (canPayMana(player.manaPool, card.manaCost)) return null
  const sources = player.zones.battlefield
    .map((id) => state.cards[id])
    .filter((source) => checkAction(state, { type: 'TAP_FOR_MANA', playerId, cardId: source.instanceId }).legal)
    .sort((left, right) => left.name.localeCompare(right.name) || left.instanceId.localeCompare(right.instanceId))
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex]
    const production = getManaProduction(source)
    for (const color of COLORS) {
      if (!(production[color] ?? 0)) continue
      const after = { ...player.manaPool, [color]: player.manaPool[color] + (production[color] ?? 1) }
      const remainingSources = sources.filter((_, index) => index !== sourceIndex).map(getManaProduction)
      if (canPayWithSources(after, remainingSources, card.manaCost)) {
        return { type: 'TAP_FOR_MANA', playerId, cardId: source.instanceId, color }
      }
    }
  }
  return null
}

function availableManaSources(state: GameState, playerId: PlayerId): Array<Partial<ManaPool>> {
  return state.players[playerId].zones.battlefield
    .map((id) => state.cards[id])
    .filter((source) => checkAction(state, { type: 'TAP_FOR_MANA', playerId, cardId: source.instanceId }).legal)
    .map(getManaProduction)
}

function canEventuallyPay(state: GameState, playerId: PlayerId, cost: string | undefined): boolean {
  return canPayWithSources(state.players[playerId].manaPool, availableManaSources(state, playerId), cost)
}

function canPayWithSources(pool: ManaPool, sources: Array<Partial<ManaPool>>, cost: string | undefined): boolean {
  const seen = new Set<string>()
  const search = (index: number, current: ManaPool): boolean => {
    if (canPayMana(current, cost)) return true
    if (index >= sources.length) return false
    const key = `${index}:${COLORS.map((color) => current[color]).join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    if (search(index + 1, current)) return true
    for (const color of COLORS) {
      const amount = sources[index][color] ?? 0
      if (amount <= 0) continue
      if (search(index + 1, { ...current, [color]: current[color] + amount })) return true
    }
    return false
  }
  return search(0, { ...pool })
}

export function chooseAttackers(state: GameState, playerId: PlayerId): CardInstanceId[] {
  if (state.phase !== 'declare_attackers' || state.activePlayerId !== playerId) return []
  const defenderId = state.combat.defendingPlayerId ?? opponentIds(state, playerId)[0]
  const blockers = defenderId ? state.players[defenderId].zones.battlefield
    .map((id) => state.cards[id])
    .filter((card) => card.types.includes('creature') && !card.tapped) : []
  const largestBlocker = blockers.reduce((largest, card) => Math.max(largest, getPower(card)), 0)
  return state.players[playerId].zones.battlefield
    .map((id) => state.cards[id])
    .filter((card) => card.types.includes('creature'))
    .filter((card) => checkAction(state, { type: 'DECLARE_ATTACKERS', playerId, attackerIds: [card.instanceId], defenderId }).legal)
    .filter((card) => {
      if (!blockers.length || (card.keywords ?? []).includes('flying') || (card.keywords ?? []).includes('indestructible')) return true
      return getToughness(card) > largestBlocker || getPower(card) >= largestBlocker
    })
    .sort((left, right) => right.instanceId.localeCompare(left.instanceId))
    .map((card) => card.instanceId)
}

export function chooseBlocks(state: GameState, playerId: PlayerId): Record<CardInstanceId, CardInstanceId[]> {
  if (state.phase !== 'declare_blockers' || state.combat.defendingPlayerId !== playerId) return {}
  const assignments: Record<CardInstanceId, CardInstanceId[]> = {}
  const available = state.players[playerId].zones.battlefield
    .map((id) => state.cards[id])
    .filter((card) => card.types.includes('creature') && !card.tapped)
    .sort((left, right) => getToughness(right) - getToughness(left) || getPower(right) - getPower(left) || left.instanceId.localeCompare(right.instanceId))
  const attackers = state.combat.attackers
    .map((id) => state.cards[id])
    .filter(Boolean)
    .sort((left, right) => getPower(right) - getPower(left) || left.instanceId.localeCompare(right.instanceId))

  for (const attacker of attackers) {
    const canBlock = (blocker: CardInstance) => {
      if ((attacker.keywords ?? []).includes('flying') && !(blocker.keywords ?? []).some((keyword) => keyword === 'flying' || keyword === 'reach')) return false
      return true
    }
    const needed = (attacker.keywords ?? []).includes('menace') ? 2 : 1
    const candidates = available.filter(canBlock)
    if (candidates.length < needed) continue
    const selected: CardInstance[] = []
    while (selected.length < needed) {
      const lethal = candidates.find((blocker) => getPower(blocker) >= getToughness(attacker))
      const blocker = lethal ?? candidates[0]
      selected.push(blocker)
      candidates.splice(candidates.indexOf(blocker), 1)
      available.splice(available.indexOf(blocker), 1)
    }
    assignments[attacker.instanceId] = selected.map((card) => card.instanceId)
  }
  return assignments
}

export function chooseBotAction(state: GameState, playerId: PlayerId): BotDecision | null {
  const player = state.players[playerId]
  if (!player || player.lost || state.winnerId || state.isDraw) return null

  if (state.phase === 'declare_attackers' && state.activePlayerId === playerId && !state.combat.attackersDeclared) {
    const attackerIds = chooseAttackers(state, playerId)
    return { action: { type: 'DECLARE_ATTACKERS', playerId, attackerIds }, reason: attackerIds.length ? 'Attack with favorable creatures.' : 'Declare no attackers.' }
  }
  if (state.phase === 'declare_blockers' && state.combat.defendingPlayerId === playerId && !state.combat.blockersDeclared) {
    const assignments = chooseBlocks(state, playerId)
    return { action: { type: 'DECLARE_BLOCKERS', playerId, assignments }, reason: Object.keys(assignments).length ? 'Make deterministic favorable blocks.' : 'Declare no blockers.' }
  }
  if (state.priorityPlayerId !== playerId) return null

  if (playerId === state.activePlayerId && ['main1', 'main2'].includes(state.phase) && !state.stack.length) {
    const land = player.zones.hand
      .map((id) => state.cards[id])
      .filter((card) => card.types.includes('land'))
      .sort((left, right) => left.name.localeCompare(right.name) || left.instanceId.localeCompare(right.instanceId))
      .find((card) => checkAction(state, { type: 'PLAY_LAND', playerId, cardId: card.instanceId }).legal)
    if (land) return { action: { type: 'PLAY_LAND', playerId, cardId: land.instanceId }, reason: `Develop mana with ${land.name}.` }
  }

  const payable = castCandidates(state, playerId, false)[0]
  if (payable) return { action: payable.action, reason: `Cast the highest-value payable spell, ${payable.card.name}.` }

  const potential = castCandidates(state, playerId, true)[0]
  if (potential) {
    const manaAction = chooseManaAction(state, playerId, potential.card)
    if (manaAction) return { action: manaAction, reason: `Produce mana for ${potential.card.name}.` }
  }

  return { action: { type: 'PASS_PRIORITY', playerId }, reason: state.stack.length ? 'Allow the top stack item to approach resolution.' : 'No stronger legal play is available.' }
}

export function runBotUntilYield(state: GameState, playerId: PlayerId, limit = 64): BotRunResult {
  let current = state
  const actions: GameAction[] = []
  for (let step = 0; step < Math.max(1, limit); step += 1) {
    if (current.winnerId || current.isDraw) return { state: current, actions, stoppedBecause: 'game_over' }
    const decision = chooseBotAction(current, playerId)
    if (!decision) {
      const reason = current.priorityPlayerId !== playerId ? 'opponent_priority' : 'no_action'
      return { state: current, actions, stoppedBecause: reason }
    }
    const result = gameReducer(current, decision.action)
    if (!result.accepted) return { state: current, actions, stoppedBecause: 'no_action' }
    current = result.state
    actions.push(decision.action)
    if (current.priorityPlayerId !== playerId && !(
      current.phase === 'declare_blockers' && current.combat.defendingPlayerId === playerId && !current.combat.blockersDeclared
    )) return { state: current, actions, stoppedBecause: 'opponent_priority' }
  }
  return { state: current, actions, stoppedBecause: 'limit' }
}
