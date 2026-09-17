import { canBlockAttacker, canPayMana, checkAction, entersTargetSlotIndices, gameReducer, getManaProduction, getPower, getToughness, matchesTargetRestriction, parseManaCost } from './game'
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

export function chooseTargets(state: GameState, playerId: PlayerId, effects: EngineEffect[], softIndices: Set<number> = new Set()): TargetRef[] | null {
  const result: TargetRef[] = Array.from({ length: requiredTargetCount(effects) })
  for (const effect of effects) {
    if (!('target' in effect) || effect.target.kind !== 'target-slot') continue
    const chosen = targetForEffect(state, playerId, effect)
    if (chosen) {
      result[effect.target.index] = chosen
      continue
    }
    // An enters-the-battlefield trigger with no legal target simply fizzles (rule 603.3c) - it never
    // blocks casting the permanent, so leave that slot empty instead of failing the whole cast.
    if (!softIndices.has(effect.target.index)) return null
  }
  while (result.length > 0 && result[result.length - 1] === undefined) result.pop()
  return result
}

const HOLDABLE_EFFECT_TYPES = new Set<EngineEffect['type']>([
  'damage',
  'destroy',
  'exile',
  'tap',
  'return_to_hand',
  'modify_stats',
  'counter_stack_item',
])

function isInstantSpeed(card: CardInstance): boolean {
  return card.types.includes('instant') || (card.keywords ?? []).includes('flash')
}

/**
 * True when this instant/flash spell is shaped like reactive removal or a combat trick (it damages,
 * destroys, exiles, taps or bounces something, pumps/protects a creature, or answers the stack) and is
 * therefore usually worth more held up for the opponent's turn or combat than fired proactively.
 * Sorcery-speed cards and creatures are never "holdable" - they should still be cast on curve.
 */
function isHoldableInstant(card: CardInstance): boolean {
  if (!isInstantSpeed(card)) return false
  const effects = [...(card.effects ?? []), ...(card.entersEffects ?? [])]
  return effects.some((effect) => HOLDABLE_EFFECT_TYPES.has(effect.type))
}

/**
 * Phase-awareness for instant-speed interaction: a holdable instant should generally NOT be cast
 * proactively in our own precombat/postcombat main phase on an otherwise unthreatening board - it is
 * worth more used in response to the opponent's actions or during their combat. We still cast it right
 * away whenever there's a concrete reason to: something is already on the stack (the correct response
 * window), or we're outside our own main phases (combat steps, the opponent's turn) where waiting longer
 * buys nothing.
 */
function shouldCastNow(state: GameState, playerId: PlayerId, card: CardInstance): boolean {
  if (!isHoldableInstant(card)) return true
  if (state.stack.length > 0) return true
  if (!(state.phase === 'main1' || state.phase === 'main2')) return true
  if (state.activePlayerId !== playerId) return true
  return false
}

function castCandidates(state: GameState, playerId: PlayerId, usePotentialMana: boolean): Array<{ action: GameAction; card: CardInstance }> {
  const player = state.players[playerId]
  return player.zones.hand
    .map((id) => state.cards[id])
    .filter((card) => !card.types.includes('land'))
    .map((card) => {
      const effects = [...(card.effects ?? []), ...(card.entersEffects ?? [])]
      const softIndices = entersTargetSlotIndices(card)
      const targets = chooseTargets(state, playerId, effects, softIndices)
      const needsTargets = requiredTargetCount(effects) > 0
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
    .sort((left, right) => cardValue(right.card) - cardValue(left.card) || (left.card.manaValue ?? 0) - (right.card.manaValue ?? 0) || left.card.name.localeCompare(right.card.name))
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

/**
 * Rough per-color demand from the cards still in hand (spells only), used to steer land sequencing
 * toward whichever land actually unlocks something instead of an arbitrary/alphabetical pick. Hybrid
 * symbols split their weight across the colors that satisfy them.
 */
function colorNeedsFromHand(state: GameState, playerId: PlayerId): Partial<Record<ManaColor, number>> {
  const needs: Partial<Record<ManaColor, number>> = {}
  for (const cardId of state.players[playerId].zones.hand) {
    const card = state.cards[cardId]
    if (card.types.includes('land')) continue
    for (const symbol of parseManaCost(card.manaCost)) {
      const colors = symbol.split('/').filter((part): part is ManaColor => COLORS.includes(part as ManaColor) && part !== 'C')
      if (!colors.length) continue
      const weight = 1 / colors.length
      for (const color of colors) needs[color] = (needs[color] ?? 0) + weight
    }
  }
  return needs
}

/** Higher is better: lands that produce colors our hand actually needs score above ones that don't,
 * and among lands that are equally useful (or equally useless) right now, more color-flexible lands
 * (duals/multi-color) are preferred since they keep future options open. */
function scoreLandForNeeds(land: CardInstance, needs: Partial<Record<ManaColor, number>>): number {
  const production = getManaProduction(land)
  const coloredProduction = COLORS.filter((color) => color !== 'C' && (production[color] ?? 0) > 0)
  const needScore = coloredProduction.reduce((sum, color) => sum + (needs[color] ?? 0), 0)
  return needScore * 10 + coloredProduction.length
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

function menaceNeeded(card: CardInstance): number {
  return (card.keywords ?? []).includes('menace') ? 2 : 1
}

function pickBlockerForAttacker(attacker: CardInstance, candidates: CardInstance[]): CardInstance {
  return candidates.find((blocker) => getPower(blocker) >= getToughness(attacker)) ?? candidates[0]
}

/** Greedily assigns blockers to attackers in the given order, preferring a blocker that kills the
 * attacker outright over just chump-blocking it. Attacker order is what determines which attackers get
 * first claim on the (possibly scarce) pool of blockers. */
function buildBlockPlan(attackers: CardInstance[], pool: CardInstance[]): Record<CardInstanceId, CardInstanceId[]> {
  const available = [...pool]
  const assignments: Record<CardInstanceId, CardInstanceId[]> = {}
  for (const attacker of attackers) {
    const needed = menaceNeeded(attacker)
    const candidates = available.filter((blocker) => canBlockAttacker(attacker, blocker))
    if (candidates.length < needed) continue
    const selected: CardInstance[] = []
    while (selected.length < needed) {
      const blocker = pickBlockerForAttacker(attacker, candidates)
      selected.push(blocker)
      candidates.splice(candidates.indexOf(blocker), 1)
      available.splice(available.indexOf(blocker), 1)
    }
    assignments[attacker.instanceId] = selected.map((card) => card.instanceId)
  }
  return assignments
}

/** Total damage that would get through under a given block plan: full attacker power for anything left
 * unblocked, plus trample overflow for anything blocked but not fully absorbed. */
function totalUnblockedDamage(state: GameState, attackers: CardInstance[], assignments: Record<CardInstanceId, CardInstanceId[]>): number {
  let total = 0
  for (const attacker of attackers) {
    const blockerIds = assignments[attacker.instanceId]
    if (!blockerIds || blockerIds.length === 0) {
      total += getPower(attacker)
      continue
    }
    if ((attacker.keywords ?? []).includes('trample')) {
      const blockerToughness = blockerIds.reduce((sum, id) => sum + getToughness(state.cards[id]), 0)
      total += Math.max(0, getPower(attacker) - blockerToughness)
    }
  }
  return total
}

export function chooseBlocks(state: GameState, playerId: PlayerId): Record<CardInstanceId, CardInstanceId[]> {
  if (state.phase !== 'declare_blockers' || state.combat.defendingPlayerId !== playerId) return {}
  const available = state.players[playerId].zones.battlefield
    .map((id) => state.cards[id])
    .filter((card) => card.types.includes('creature') && !card.tapped)
    .sort((left, right) => getToughness(right) - getToughness(left) || getPower(right) - getPower(left) || left.instanceId.localeCompare(right.instanceId))
  const attackers = state.combat.attackers
    .map((id) => state.cards[id])
    .filter(Boolean)
    .sort((left, right) => getPower(right) - getPower(left) || left.instanceId.localeCompare(right.instanceId))

  const greedy = buildBlockPlan(attackers, available)
  const life = state.players[playerId].life
  if (totalUnblockedDamage(state, attackers, greedy) < life) return greedy

  // The value-oriented plan above would let lethal (or exactly-lethal) damage through. Before accepting
  // that, check whether ANY legal block assignment - even a pure, unprofitable chump block - keeps us
  // alive, and prefer it: staying alive beats optimizing for favorable trades. Re-ordering attackers by
  // "power prevented per blocker spent" (rather than raw power) lets a single-blocker attacker outrank a
  // menace attacker of the same power, since double-blocking menace can otherwise eat blockers that would
  // have covered two other attackers instead.
  const survivalAttackerOrder = [...attackers].sort((left, right) => {
    const leftRatio = getPower(left) / menaceNeeded(left)
    const rightRatio = getPower(right) / menaceNeeded(right)
    return rightRatio - leftRatio || getPower(right) - getPower(left) || left.instanceId.localeCompare(right.instanceId)
  })
  const survival = buildBlockPlan(survivalAttackerOrder, available)
  if (totalUnblockedDamage(state, attackers, survival) < life) return survival

  // No legal assignment prevents lethal - nothing left to do but fall back to the value-oriented plan.
  return greedy
}

export function chooseBotAction(state: GameState, playerId: PlayerId): BotDecision | null {
  const player = state.players[playerId]
  if (!player || player.lost || state.winnerId || state.isDraw) return null

  if (state.pendingDiscard === playerId) {
    const required = player.zones.hand.length - 7
    const cardIds = [...player.zones.hand]
      .sort((left, right) => cardValue(state.cards[left]) - cardValue(state.cards[right]))
      .slice(0, Math.max(0, required))
    return { action: { type: 'DISCARD_CARDS', playerId, cardIds }, reason: 'Discard the lowest-value cards down to the maximum hand size.' }
  }

  if (state.phase === 'declare_attackers' && state.activePlayerId === playerId && !state.combat.attackersDeclared) {
    const attackerIds = chooseAttackers(state, playerId)
    return { action: { type: 'DECLARE_ATTACKERS', playerId, attackerIds }, reason: attackerIds.length ? 'Attack with favorable creatures.' : 'Declare no attackers.' }
  }
  if (state.phase === 'declare_blockers' && state.combat.defendingPlayerId === playerId && !state.combat.blockersDeclared) {
    const assignments = chooseBlocks(state, playerId)
    return { action: { type: 'DECLARE_BLOCKERS', playerId, assignments }, reason: Object.keys(assignments).length ? 'Make deterministic favorable blocks.' : 'Declare no blockers.' }
  }
  if (state.priorityPlayerId !== playerId) return null

  if (state.phase === 'declare_blockers' && state.combat.blockersDeclared && state.activePlayerId === playerId) {
    for (const attackerId of state.combat.attackers) {
      const attacker = state.cards[attackerId]
      if (!attacker || attacker.controllerId !== playerId) continue
      const blockers = state.combat.blockers[attackerId] ?? []
      if (blockers.length < 2) continue
      // Default policy: assign damage to the cheapest blocker first so it dies before the more expensive one.
      const order = [...blockers].sort((left, right) => getToughness(state.cards[left]) - getToughness(state.cards[right]) || left.localeCompare(right))
      if (order.some((id, index) => id !== blockers[index])) {
        return { action: { type: 'ORDER_BLOCKERS', playerId, attackerId, order }, reason: `Order damage on ${attacker.name} to kill the cheapest blocker first.` }
      }
    }
  }

  if (playerId === state.activePlayerId && ['main1', 'main2'].includes(state.phase) && !state.stack.length) {
    const needs = colorNeedsFromHand(state, playerId)
    const land = player.zones.hand
      .map((id) => state.cards[id])
      .filter((card) => card.types.includes('land'))
      .filter((card) => checkAction(state, { type: 'PLAY_LAND', playerId, cardId: card.instanceId }).legal)
      .sort((left, right) => scoreLandForNeeds(right, needs) - scoreLandForNeeds(left, needs) || left.name.localeCompare(right.name) || left.instanceId.localeCompare(right.instanceId))[0]
    if (land) return { action: { type: 'PLAY_LAND', playerId, cardId: land.instanceId }, reason: `Develop mana with ${land.name}.` }
  }

  const payable = castCandidates(state, playerId, false).find((candidate) => shouldCastNow(state, playerId, candidate.card))
  if (payable) return { action: payable.action, reason: `Cast the highest-value payable spell, ${payable.card.name}.` }

  const potential = castCandidates(state, playerId, true).find((candidate) => shouldCastNow(state, playerId, candidate.card))
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
