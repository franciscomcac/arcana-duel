import {
  EMPTY_MANA_POOL,
  MAX_HAND_SIZE,
  PHASES,
  type ActionResult,
  type CardDefinition,
  type CardInstance,
  type CardInstanceId,
  type CreateGameOptions,
  type EffectTarget,
  type EngineEffect,
  type GameAction,
  type GamePhase,
  type GameState,
  type LegalityResult,
  type ManaColor,
  type ManaPool,
  type PlayerId,
  type PlayerState,
  type TargetRef,
  type TargetRestriction,
  type ZoneName,
} from './types'

const PERMANENT_TYPES = new Set(['artifact', 'battle', 'creature', 'enchantment', 'planeswalker'])
const COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

const emptyMana = (): ManaPool => ({ ...EMPTY_MANA_POOL })

const emptyZones = (): PlayerState['zones'] => ({
  library: [],
  hand: [],
  battlefield: [],
  graveyard: [],
  exile: [],
  command: [],
})

const emptyCombat = (): GameState['combat'] => ({
  defendingPlayerId: null,
  attackers: [],
  blockers: {},
  attackersDeclared: false,
  blockersDeclared: false,
  firstStrikeDamageDealt: false,
  damageDealt: false,
})

function cloneState(state: GameState): GameState {
  const players = Object.fromEntries(
    Object.entries(state.players).map(([id, player]) => [id, {
      ...player,
      manaPool: { ...player.manaPool },
      zones: Object.fromEntries(
        Object.entries(player.zones).map(([zone, ids]) => [zone, [...ids]]),
      ) as unknown as PlayerState['zones'],
    }]),
  )
  const cards = Object.fromEntries(
    Object.entries(state.cards).map(([id, card]) => [id, {
      ...card,
      types: [...card.types],
      keywords: [...(card.keywords ?? [])],
      grantedKeywords: [...(card.grantedKeywords ?? [])],
      counters: { ...card.counters },
      producesMana: card.producesMana ? { ...card.producesMana } : undefined,
      effects: card.effects?.map(cloneEffect),
      entersEffects: card.entersEffects?.map(cloneEffect),
    }]),
  )
  return {
    ...state,
    players,
    cards,
    stack: state.stack.map((item) => ({
      ...item,
      targets: item.targets.map((target) => ({ ...target })),
      effects: item.effects.map(cloneEffect),
    })),
    combat: {
      ...state.combat,
      attackers: [...state.combat.attackers],
      blockers: Object.fromEntries(Object.entries(state.combat.blockers).map(([id, blockers]) => [id, [...blockers]])),
    },
    events: [...state.events],
  }
}

function cloneEffect(effect: EngineEffect): EngineEffect {
  if ('target' in effect) return { ...effect, target: { ...effect.target } } as EngineEffect
  if (effect.type === 'add_mana') return { ...effect, mana: { ...effect.mana } }
  if (effect.type === 'create_token') return {
    ...effect,
    token: {
      ...effect.token,
      types: [...effect.token.types],
      keywords: [...(effect.token.keywords ?? [])],
      effects: effect.token.effects?.map(cloneEffect),
      entersEffects: effect.token.entersEffects?.map(cloneEffect),
    },
  }
  return { ...effect }
}

function addEvent(
  state: GameState,
  type: string,
  message: string,
  details: { playerId?: PlayerId; cardId?: CardInstanceId } = {},
): void {
  state.eventSequence += 1
  state.events.push({
    id: state.eventSequence,
    turn: state.turnNumber,
    phase: state.phase,
    type,
    message,
    ...details,
  })
}

function reject(state: GameState, error: string): ActionResult {
  return { state, accepted: false, error }
}

function alivePlayers(state: GameState): PlayerId[] {
  return state.playerOrder.filter((id) => !state.players[id].lost)
}

export function nextPlayerId(state: GameState, from: PlayerId): PlayerId {
  const start = state.playerOrder.indexOf(from)
  for (let offset = 1; offset <= state.playerOrder.length; offset += 1) {
    const id = state.playerOrder[(start + offset) % state.playerOrder.length]
    if (!state.players[id].lost) return id
  }
  return from
}

function locateCard(state: GameState, cardId: CardInstanceId): { playerId: PlayerId; zone: ZoneName; index: number } | null {
  for (const playerId of state.playerOrder) {
    const zones = state.players[playerId].zones
    for (const zone of Object.keys(zones) as ZoneName[]) {
      const index = zones[zone].indexOf(cardId)
      if (index >= 0) return { playerId, zone, index }
    }
  }
  return null
}

/** Clears attachedToId on anything that was attached to cardId (rule: an Equipment/Aura falls off, unattached
 * but still on the battlefield, when what it was attached to leaves the battlefield). */
function detachAnythingAttachedTo(state: GameState, cardId: CardInstanceId): void {
  for (const other of Object.values(state.cards)) {
    if (other.attachedToId === cardId) other.attachedToId = undefined
  }
}

function moveCard(state: GameState, cardId: CardInstanceId, destinationPlayerId: PlayerId, destination: ZoneName): boolean {
  const location = locateCard(state, cardId)
  if (!location) return false
  const wasOnBattlefield = location.zone === 'battlefield'
  state.players[location.playerId].zones[location.zone].splice(location.index, 1)
  state.players[destinationPlayerId].zones[destination].push(cardId)
  const card = state.cards[cardId]
  if (destination === 'battlefield') {
    card.controllerId = destinationPlayerId
    card.tapped = false
    card.damageMarked = 0
    card.attacking = false
    card.blocking = null
    card.enteredTurn = state.turnNumber
    card.summoningSick = card.types.includes('creature')
    card.attachedToId = undefined
  } else {
    card.controllerId = card.ownerId
    card.tapped = false
    card.damageMarked = 0
    card.attacking = false
    card.blocking = null
    card.counters = {}
    card.temporaryPower = 0
    card.temporaryToughness = 0
    card.attachedToId = undefined
  }
  if (wasOnBattlefield && destination !== 'battlefield') detachAnythingAttachedTo(state, cardId)
  return true
}

function drawCards(state: GameState, playerId: PlayerId, amount: number, isOpeningDraw = false): void {
  const player = state.players[playerId]
  for (let count = 0; count < amount; count += 1) {
    const cardId = player.zones.library.shift()
    if (!cardId) {
      if (!isOpeningDraw) {
        player.lost = true
        addEvent(state, 'empty_draw', `${player.name} tried to draw from an empty library.`, { playerId })
      }
      return
    }
    player.zones.hand.push(cardId)
    player.cardsDrawn += 1
    addEvent(state, 'draw', `${player.name} drew a card.`, { playerId, cardId })
  }
}

export function createGame(options: CreateGameOptions): GameState {
  if (options.players.length < 2) throw new Error('A game requires at least two players.')
  const ids = options.players.map((player) => player.id)
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) throw new Error('Player IDs must be unique and non-empty.')
  const startingPlayerId = options.startingPlayerId ?? ids[0]
  if (!ids.includes(startingPlayerId)) throw new Error('The starting player must be part of the game.')

  const players: Record<PlayerId, PlayerState> = {}
  const cards: Record<CardInstanceId, CardInstance> = {}
  const openingHandSize = Math.max(0, options.openingHandSize ?? 7)
  const state: GameState = {
    players,
    playerOrder: ids,
    cards,
    phase: 'untap',
    turnNumber: 1,
    activePlayerId: startingPlayerId,
    priorityPlayerId: startingPlayerId,
    consecutivePasses: 0,
    stack: [],
    combat: emptyCombat(),
    winnerId: null,
    isDraw: false,
    started: true,
    skipFirstDraw: options.skipFirstDraw ?? true,
    eventSequence: 0,
    stackSequence: 0,
    events: [],
    pendingDiscard: null,
  }

  for (const setup of options.players) {
    const zones = emptyZones()
    players[setup.id] = {
      id: setup.id,
      name: setup.name,
      life: options.startingLife ?? 20,
      manaPool: emptyMana(),
      zones,
      landsPlayedThisTurn: 0,
      landPlayLimit: 1,
      cardsDrawn: 0,
      lost: false,
    }
    setup.deck.forEach((definition, index) => {
      const instanceId = `${setup.id}:${definition.id}:${index + 1}`
      cards[instanceId] = makeInstance(definition, instanceId, setup.id, 0, false)
      zones.library.push(instanceId)
    })
  }
  for (const playerId of ids) drawCards(state, playerId, openingHandSize, true)
  addEvent(state, 'game_start', `${players[startingPlayerId].name} takes the first turn.`, { playerId: startingPlayerId })
  return runStateBasedActions(state)
}

/** Best-effort type line for cards that don't specify one explicitly, so "controls a [subtype]" checks work generally. */
function deriveTypeLine(definition: CardDefinition): string {
  if (definition.typeLine) return definition.typeLine
  const superTypes = definition.types.map((type) => type.charAt(0).toUpperCase() + type.slice(1)).join(' ')
  // Basic lands (and many simple permanents) use the card name as their subtype.
  return superTypes ? `${superTypes} - ${definition.name}` : definition.name
}

function makeInstance(
  definition: CardDefinition,
  instanceId: CardInstanceId,
  ownerId: PlayerId,
  enteredTurn: number,
  token: boolean,
): CardInstance {
  const typeLine = deriveTypeLine(definition)
  return {
    ...definition,
    types: [...definition.types],
    typeLine,
    legendary: definition.legendary ?? /\blegendary\b/i.test(typeLine),
    keywords: [...(definition.keywords ?? [])],
    producesMana: definition.producesMana ? { ...definition.producesMana } : undefined,
    effects: definition.effects?.map(cloneEffect),
    entersEffects: definition.entersEffects?.map(cloneEffect),
    instanceId,
    ownerId,
    controllerId: ownerId,
    tapped: false,
    counters: {},
    damageMarked: 0,
    summoningSick: definition.types.includes('creature'),
    enteredTurn,
    temporaryPower: 0,
    temporaryToughness: 0,
    continuousPower: 0,
    continuousToughness: 0,
    attacking: false,
    blocking: null,
    token,
    attachedToId: undefined,
    grantedKeywords: [],
  }
}

export function hasKeyword(card: CardInstance, keyword: string): boolean {
  const normalized = keyword.toLowerCase()
  if ((card.keywords ?? []).some((value) => value.toLowerCase() === normalized)) return true
  return (card.grantedKeywords ?? []).some((value) => value.toLowerCase() === normalized)
}

/** Flying/reach legality only (rule 509.1b) - menace is a property of the whole blocker set, checked separately. */
export function canBlockAttacker(attacker: CardInstance, blocker: CardInstance): boolean {
  if (hasKeyword(attacker, 'flying') && !hasKeyword(blocker, 'flying') && !hasKeyword(blocker, 'reach')) return false
  return true
}

export function getPower(card: CardInstance): number {
  return (card.power ?? 0) + (card.counters['+1/+1'] ?? 0) - (card.counters['-1/-1'] ?? 0) + card.temporaryPower + card.continuousPower
}

export function getToughness(card: CardInstance): number {
  return (card.toughness ?? 0) + (card.counters['+1/+1'] ?? 0) - (card.counters['-1/-1'] ?? 0) + card.temporaryToughness + card.continuousToughness
}

/** Recomputes simple continuous bonuses that depend on the controller's battlefield, plus what any
 * attached Equipment/Aura is currently granting (see AttachGrant on CardDefinition). */
export function refreshContinuousEffects(state: GameState): void {
  for (const card of Object.values(state.cards)) {
    card.continuousPower = 0
    card.continuousToughness = 0
    card.grantedKeywords = []
  }
  const battlefieldCards = Object.values(state.players).flatMap((player) => player.zones.battlefield)
  for (const cardId of battlefieldCards) {
    const card = state.cards[cardId]
    if (!card) continue
    if (!card.types.includes('creature')) continue
    const match = card.oracleText?.match(/gets?\s+\+(\d+)\/\+(\d+)\s+as long as you control a[n]?\s+([^.,]+?)(?:\.|$)/i)
    if (!match) continue
    const requiredType = match[3].trim().toLocaleLowerCase()
    const controlsRequired = state.players[card.controllerId]?.zones.battlefield.some((id) => {
      const permanent = state.cards[id]
      if (!permanent) return false
      const haystack = `${permanent.typeLine ?? ''} ${permanent.name}`.toLocaleLowerCase()
      return haystack.includes(requiredType)
    }) ?? false
    const powerBonus = Number(match[1])
    const toughnessBonus = Number(match[2])
    if (controlsRequired) {
      card.continuousPower = powerBonus
      card.continuousToughness = toughnessBonus
    }
  }
  // Equip/Aura attachment grants. Generic over any permanent that carries an attachGrant - not specific
  // to any one card - so any future "equipped/enchanted creature gets ... and has ..." card just works.
  for (const cardId of battlefieldCards) {
    const attachment = state.cards[cardId]
    if (!attachment?.attachedToId || !attachment.attachGrant) continue
    const creature = state.cards[attachment.attachedToId]
    if (!creature || !creature.types.includes('creature')) continue
    if (!state.players[creature.controllerId]?.zones.battlefield.includes(creature.instanceId)) continue
    creature.continuousPower += attachment.attachGrant.power ?? 0
    creature.continuousToughness += attachment.attachGrant.toughness ?? 0
    for (const keyword of attachment.attachGrant.keywords ?? []) {
      const normalized = keyword.toLowerCase()
      if (!creature.grantedKeywords.includes(normalized)) creature.grantedKeywords.push(normalized)
    }
  }
}

export function canPayMana(pool: ManaPool, cost: string | undefined, xValue = 0): boolean {
  return payMana(pool, cost, xValue) !== null
}

export function payMana(pool: ManaPool, cost: string | undefined, xValue = 0): ManaPool | null {
  const remaining = { ...pool }
  const symbols = parseManaCost(cost)
  let generic = Math.max(0, xValue)
  for (const symbol of symbols) {
    if (/^\d+$/.test(symbol)) {
      generic += Number(symbol)
      continue
    }
    if (symbol === 'X') continue
    if (COLORS.includes(symbol as ManaColor)) {
      const color = symbol as ManaColor
      if (remaining[color] <= 0) return null
      remaining[color] -= 1
      continue
    }
    const hybrid = symbol.split('/').filter((part): part is ManaColor => COLORS.includes(part as ManaColor))
    const available = hybrid.find((color) => remaining[color] > 0)
    if (!available) return null
    remaining[available] -= 1
  }
  for (const color of ['C', 'W', 'U', 'B', 'R', 'G'] as ManaColor[]) {
    const payment = Math.min(generic, remaining[color])
    generic -= payment
    remaining[color] -= payment
  }
  return generic === 0 ? remaining : null
}

export function parseManaCost(cost = ''): string[] {
  const braced = [...cost.toUpperCase().matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
  if (braced.length) return braced
  return cost.toUpperCase().match(/\d+|[WUBRGCX]/g) ?? []
}

export function getManaProduction(card: CardInstance): Partial<ManaPool> {
  if (card.producesMana && Object.values(card.producesMana).some((amount) => (amount ?? 0) > 0)) return { ...card.producesMana }
  const text = card.oracleText ?? ''
  const produced: Partial<ManaPool> = {}
  for (const match of text.matchAll(/add\s+\{([WUBRGC])\}/gi)) {
    const color = match[1].toUpperCase() as ManaColor
    produced[color] = (produced[color] ?? 0) + 1
  }
  return produced
}

export function checkAction(state: GameState, action: GameAction): LegalityResult {
  if (!state.started || state.winnerId || state.isDraw) return { legal: false, reason: 'The game is over.' }
  const player = state.players[action.playerId]
  if (!player || player.lost) return { legal: false, reason: 'That player cannot act.' }
  if (action.type !== 'CONCEDE' && action.type !== 'DECLARE_ATTACKERS' && action.type !== 'DECLARE_BLOCKERS' && action.type !== 'DISCARD_CARDS') {
    const gate = declarationGate(state)
    if (!gate.legal) return gate
  }

  switch (action.type) {
    case 'CONCEDE':
      return { legal: true }
    case 'PASS_PRIORITY':
      if (state.priorityPlayerId !== action.playerId) return { legal: false, reason: 'That player does not have priority.' }
      return { legal: true }
    case 'ADVANCE_PHASE':
      return { legal: false, reason: 'A phase advances only after every player passes priority in succession.' }
    case 'PLAY_LAND':
      if (action.playerId !== state.activePlayerId || state.priorityPlayerId !== action.playerId) return { legal: false, reason: 'A land can only be played by the active player with priority.' }
      if (!['main1', 'main2'].includes(state.phase) || state.stack.length) return { legal: false, reason: 'A land can only be played during a main phase with an empty stack.' }
      if (!player.zones.hand.includes(action.cardId) || !state.cards[action.cardId]?.types.includes('land')) return { legal: false, reason: 'That land is not in the player’s hand.' }
      if (player.landsPlayedThisTurn >= player.landPlayLimit) return { legal: false, reason: 'The land play limit has been reached.' }
      return { legal: true }
    case 'TAP_FOR_MANA': {
      if (state.priorityPlayerId !== action.playerId) return { legal: false, reason: 'That player does not have priority.' }
      const card = state.cards[action.cardId]
      if (!card || card.controllerId !== action.playerId || !player.zones.battlefield.includes(action.cardId)) return { legal: false, reason: 'That permanent is not controlled by the player.' }
      if (card.tapped) return { legal: false, reason: 'That permanent is already tapped.' }
      if (card.types.includes('creature') && card.summoningSick && !hasKeyword(card, 'haste')) return { legal: false, reason: 'That creature has summoning sickness.' }
      const production = getManaProduction(card)
      if (!Object.values(production).some((amount) => (amount ?? 0) > 0)) return { legal: false, reason: 'That permanent has no supported mana ability.' }
      if (action.color && !(action.color in production)) return { legal: false, reason: 'That permanent cannot produce the requested color.' }
      return { legal: true }
    }
    case 'CAST_SPELL': {
      if (state.priorityPlayerId !== action.playerId) return { legal: false, reason: 'That player does not have priority.' }
      const card = state.cards[action.cardId]
      if (!card || !player.zones.hand.includes(action.cardId) || card.types.includes('land')) return { legal: false, reason: 'That spell is not in the player’s hand.' }
      const instantTiming = card.types.includes('instant') || hasKeyword(card, 'flash')
      if (!instantTiming && (action.playerId !== state.activePlayerId || !['main1', 'main2'].includes(state.phase) || state.stack.length)) {
        return { legal: false, reason: 'That spell requires sorcery timing.' }
      }
      if (!canPayMana(player.manaPool, card.manaCost, action.xValue)) return { legal: false, reason: 'The player cannot pay that mana cost.' }
      const targetError = validateEffectTargets(
        state,
        [...(card.effects ?? []), ...(card.entersEffects ?? [])],
        action.targets ?? [],
        action.playerId,
        entersTargetSlotIndices(card),
      )
      return targetError ? { legal: false, reason: targetError } : { legal: true }
    }
    case 'ACTIVATE_ABILITY': {
      if (state.priorityPlayerId !== action.playerId) return { legal: false, reason: 'That player does not have priority.' }
      const source = state.cards[action.sourceId]
      if (!source || source.controllerId !== action.playerId || !player.zones.battlefield.includes(action.sourceId)) return { legal: false, reason: 'The ability source is not controlled by the player.' }
      if (action.tapSource && source.tapped) return { legal: false, reason: 'The ability source is tapped.' }
      if (action.tapSource && source.types.includes('creature') && source.summoningSick && !hasKeyword(source, 'haste')) return { legal: false, reason: 'The ability source has summoning sickness.' }
      if (action.sorcerySpeedOnly && (action.playerId !== state.activePlayerId || !['main1', 'main2'].includes(state.phase) || state.stack.length)) {
        return { legal: false, reason: 'That ability can only be activated when a sorcery could be cast.' }
      }
      if (!canPayMana(player.manaPool, action.manaCost)) return { legal: false, reason: 'The player cannot pay the ability cost.' }
      if (action.discardCount) {
        if (!action.discardCardIds || action.discardCardIds.length !== action.discardCount) {
          return { legal: false, reason: `This ability requires discarding ${action.discardCount} card(s).` }
        }
        if (new Set(action.discardCardIds).size !== action.discardCardIds.length || action.discardCardIds.some((id) => !player.zones.hand.includes(id))) {
          return { legal: false, reason: 'That discard selection is invalid.' }
        }
      }
      if (action.payLife !== undefined && player.life < action.payLife) return { legal: false, reason: 'The player cannot pay that much life.' }
      const targetError = validateEffectTargets(state, action.effects, action.targets ?? [], action.playerId)
      return targetError ? { legal: false, reason: targetError } : { legal: true }
    }
    case 'DECLARE_ATTACKERS':
      return checkAttackers(state, action.playerId, action.attackerIds, action.defenderId)
    case 'DECLARE_BLOCKERS':
      return checkBlockers(state, action.playerId, action.assignments)
    case 'ORDER_BLOCKERS': {
      if (state.phase !== 'declare_blockers' || !state.combat.blockersDeclared) return { legal: false, reason: 'Blockers must be declared before damage order can be set.' }
      const attacker = state.cards[action.attackerId]
      if (!attacker || attacker.controllerId !== action.playerId || !state.combat.attackers.includes(action.attackerId)) return { legal: false, reason: 'That attacker is not controlled by the player.' }
      const current = state.combat.blockers[action.attackerId] ?? []
      if (current.length < 2) return { legal: false, reason: 'Damage order only matters with two or more blockers.' }
      if (action.order.length !== current.length || new Set(action.order).size !== current.length || !action.order.every((id) => current.includes(id))) {
        return { legal: false, reason: 'The chosen order must include exactly the declared blockers.' }
      }
      return { legal: true }
    }
    case 'DISCARD_CARDS': {
      if (state.pendingDiscard !== action.playerId) return { legal: false, reason: 'That player has nothing to discard right now.' }
      const required = player.zones.hand.length - MAX_HAND_SIZE
      if (action.cardIds.length !== required) return { legal: false, reason: `Choose exactly ${required} card(s) to discard.` }
      if (new Set(action.cardIds).size !== action.cardIds.length || action.cardIds.some((id) => !player.zones.hand.includes(id))) {
        return { legal: false, reason: 'That discard selection is invalid.' }
      }
      return { legal: true }
    }
  }
}

function declarationGate(state: GameState): LegalityResult {
  if (state.pendingDiscard) return { legal: false, reason: `${state.players[state.pendingDiscard]?.name ?? 'A player'} must discard down to the maximum hand size.` }
  if (state.phase === 'declare_attackers' && !state.combat.attackersDeclared) return { legal: false, reason: 'Attackers must be declared, even if the set is empty.' }
  if (state.phase === 'declare_blockers' && !state.combat.blockersDeclared) return { legal: false, reason: 'Blockers must be declared, even if the set is empty.' }
  return { legal: true }
}

function validateTargets(state: GameState, targets: TargetRef[]): string | undefined {
  for (const target of targets) {
    if (!target) continue // an empty slot left by an omitted optional (fizzling) enters-the-battlefield target
    if (target.kind === 'player' && (!state.players[target.playerId] || state.players[target.playerId].lost)) return 'A player target is invalid.'
    if (target.kind === 'permanent' && !Object.values(state.players).some((player) => player.zones.battlefield.includes(target.cardId))) return 'A permanent target is invalid.'
    if (target.kind === 'stack' && !state.stack.some((item) => item.id === target.stackItemId)) return 'A stack target is invalid.'
  }
  return undefined
}

export function matchesTargetRestriction(
  state: GameState,
  target: TargetRef,
  restriction: TargetRestriction | undefined,
  controllerId: PlayerId,
): boolean {
  if (!restriction) return true
  if (restriction === 'spell') return target.kind === 'stack' && state.stack.some((item) => item.id === target.stackItemId && item.counterable)
  if (restriction === 'any-target' && target.kind === 'player') return Boolean(state.players[target.playerId] && !state.players[target.playerId].lost)
  if (restriction === 'player') return target.kind === 'player'
  if (restriction === 'opponent') return target.kind === 'player' && target.playerId !== controllerId
  if (target.kind !== 'permanent') return false
  const card = state.cards[target.cardId]
  if (!card || locateCard(state, target.cardId)?.zone !== 'battlefield') return false
  if (restriction === 'permanent') return true
  if (restriction === 'any-target') return card.types.some((type) => ['creature', 'planeswalker', 'battle'].includes(type))
  if (restriction === 'controlled-creature') return card.controllerId === controllerId && card.types.includes('creature')
  if (restriction === 'opponent-creature') return card.controllerId !== controllerId && card.types.includes('creature')
  if (restriction === 'artifact-or-enchantment') return card.types.includes('artifact') || card.types.includes('enchantment')
  return card.types.includes(restriction)
}

/** Target-slot indices sourced only from a permanent's enters-the-battlefield trigger (rule 603.3c: fizzles harmlessly with no legal target, never blocks casting the permanent itself). */
export function entersTargetSlotIndices(card: CardInstance): Set<number> {
  const indices = new Set<number>()
  for (const effect of card.entersEffects ?? []) {
    if ('target' in effect && effect.target.kind === 'target-slot') indices.add(effect.target.index)
  }
  return indices
}

/** Whether any permanent or player on the battlefield/in the game currently satisfies a target restriction. */
export function anyLegalTargetExists(state: GameState, restriction: TargetRestriction | undefined, controllerId: PlayerId): boolean {
  const permanentIds = state.playerOrder.flatMap((id) => state.players[id].zones.battlefield)
  if (permanentIds.some((cardId) => matchesTargetRestriction(state, { kind: 'permanent', cardId }, restriction, controllerId))) return true
  if (state.playerOrder.some((id) => matchesTargetRestriction(state, { kind: 'player', playerId: id }, restriction, controllerId))) return true
  if (state.stack.some((item) => matchesTargetRestriction(state, { kind: 'stack', stackItemId: item.id }, restriction, controllerId))) return true
  return false
}

function validateEffectTargets(state: GameState, effects: EngineEffect[], targets: TargetRef[], controllerId: PlayerId, softIndices: Set<number> = new Set()): string | undefined {
  const basicError = validateTargets(state, targets)
  if (basicError) return basicError
  for (const effect of effects) {
    if (!('target' in effect) || effect.target.kind !== 'target-slot') continue
    const target = targets[effect.target.index]
    if (!target) {
      if (softIndices.has(effect.target.index) && !anyLegalTargetExists(state, effect.target.restriction, controllerId)) continue
      return `Target ${effect.target.index + 1} is required.`
    }
    if (!matchesTargetRestriction(state, target, effect.target.restriction, controllerId)) return 'That object is not a legal target for this effect.'
    if (effect.type === 'counter_stack_item' && target.kind !== 'stack') return 'A counter effect must target a stack item.'
    if (['destroy', 'exile', 'return_to_hand', 'tap', 'untap', 'modify_stats', 'add_counter', 'remove_counter', 'attach'].includes(effect.type) && target.kind !== 'permanent') {
      return 'That effect must target a permanent.'
    }
    if (effect.type === 'damage' && target.kind === 'stack') return 'Damage cannot target a stack item.'
  }
  return undefined
}

function checkAttackers(state: GameState, playerId: PlayerId, attackerIds: CardInstanceId[], defenderId?: PlayerId): LegalityResult {
  if (state.phase !== 'declare_attackers' || playerId !== state.activePlayerId) return { legal: false, reason: 'Attackers can only be declared by the active player in the declare attackers step.' }
  if (state.combat.attackersDeclared) return { legal: false, reason: 'Attackers have already been declared.' }
  if (new Set(attackerIds).size !== attackerIds.length) return { legal: false, reason: 'An attacker cannot be declared twice.' }
  const defender = defenderId ?? nextPlayerId(state, playerId)
  if (!state.players[defender] || state.players[defender].lost || defender === playerId) return { legal: false, reason: 'The defending player is invalid.' }
  for (const id of attackerIds) {
    const card = state.cards[id]
    if (!card || card.controllerId !== playerId || !state.players[playerId].zones.battlefield.includes(id) || !card.types.includes('creature')) return { legal: false, reason: 'Every attacker must be a creature controlled by the active player.' }
    if (card.tapped) return { legal: false, reason: `${card.name} is tapped.` }
    if (hasKeyword(card, 'defender')) return { legal: false, reason: `${card.name} has defender.` }
    if (card.summoningSick && !hasKeyword(card, 'haste')) return { legal: false, reason: `${card.name} has summoning sickness.` }
  }
  return { legal: true }
}

function checkBlockers(state: GameState, playerId: PlayerId, assignments: Record<CardInstanceId, CardInstanceId[]>): LegalityResult {
  if (state.phase !== 'declare_blockers' || playerId !== state.combat.defendingPlayerId) return { legal: false, reason: 'Only the defending player can declare blockers in this step.' }
  if (state.combat.blockersDeclared) return { legal: false, reason: 'Blockers have already been declared.' }
  const seen = new Set<CardInstanceId>()
  for (const [attackerId, blockerIds] of Object.entries(assignments)) {
    if (!state.combat.attackers.includes(attackerId)) return { legal: false, reason: 'A blocker was assigned to a non-attacking creature.' }
    const attacker = state.cards[attackerId]
    if (hasKeyword(attacker, 'menace') && blockerIds.length === 1) return { legal: false, reason: `${attacker.name} has menace and must be blocked by at least two creatures.` }
    for (const blockerId of blockerIds) {
      if (seen.has(blockerId)) return { legal: false, reason: 'A creature cannot block more than one attacker.' }
      seen.add(blockerId)
      const blocker = state.cards[blockerId]
      if (!blocker || blocker.controllerId !== playerId || !state.players[playerId].zones.battlefield.includes(blockerId) || !blocker.types.includes('creature') || blocker.tapped) return { legal: false, reason: 'Every blocker must be an untapped creature controlled by the defending player.' }
      if (!canBlockAttacker(attacker, blocker)) return { legal: false, reason: `${blocker.name} cannot block a creature with flying.` }
    }
  }
  return { legal: true }
}

export function gameReducer(state: GameState, action: GameAction): ActionResult {
  const legality = checkAction(state, action)
  if (!legality.legal) return reject(state, legality.reason ?? 'Illegal action.')
  const next = cloneState(state)
  refreshContinuousEffects(next)
  const player = next.players[action.playerId]

  switch (action.type) {
    case 'CONCEDE':
      player.lost = true
      addEvent(next, 'concede', `${player.name} conceded.`, { playerId: action.playerId })
      break
    case 'PLAY_LAND': {
      const card = next.cards[action.cardId]
      moveCard(next, action.cardId, action.playerId, 'battlefield')
      player.landsPlayedThisTurn += 1
      next.consecutivePasses = 0
      addEvent(next, 'play_land', `${player.name} played ${card.name}.`, { playerId: action.playerId, cardId: action.cardId })
      break
    }
    case 'TAP_FOR_MANA': {
      const card = next.cards[action.cardId]
      const production = getManaProduction(card)
      const color = action.color ?? COLORS.find((candidate) => (production[candidate] ?? 0) > 0)
      if (color) player.manaPool[color] += production[color] ?? 1
      card.tapped = true
      next.consecutivePasses = 0
      addEvent(next, 'mana', `${player.name} tapped ${card.name} for ${color ?? 'mana'}.`, { playerId: action.playerId, cardId: action.cardId })
      break
    }
    case 'CAST_SPELL': {
      const card = next.cards[action.cardId]
      player.manaPool = payMana(player.manaPool, card.manaCost, action.xValue) ?? player.manaPool
      const location = locateCard(next, action.cardId)
      if (location) next.players[location.playerId].zones[location.zone].splice(location.index, 1)
      next.stackSequence += 1
      next.stack.push({
        id: `stack:${next.turnNumber}:${next.stackSequence}`,
        kind: 'spell',
        controllerId: action.playerId,
        sourceId: action.cardId,
        cardId: action.cardId,
        name: card.name,
        effects: card.effects?.map(cloneEffect) ?? [],
        targets: (action.targets ?? []).map((target) => ({ ...target })),
        counterable: true,
      })
      next.consecutivePasses = 0
      addEvent(next, 'cast', `${player.name} cast ${card.name}.`, { playerId: action.playerId, cardId: action.cardId })
      break
    }
    case 'ACTIVATE_ABILITY': {
      const source = next.cards[action.sourceId]
      player.manaPool = payMana(player.manaPool, action.manaCost) ?? player.manaPool
      if (action.tapSource) source.tapped = true
      if (action.payLife) player.life -= action.payLife
      if (action.discardCardIds?.length) {
        for (const cardId of action.discardCardIds) moveCard(next, cardId, action.playerId, 'graveyard')
      }
      // Sacrifice-as-a-cost happens immediately on activation (rule 602.5g), before the ability resolves.
      if (action.sacrificeSource) moveCard(next, action.sourceId, source.ownerId, 'graveyard')
      next.consecutivePasses = 0
      if (action.manaAbility) {
        applyEffects(next, action.effects, action.targets ?? [], action.playerId, action.sourceId)
        addEvent(next, 'mana_ability', `${player.name} activated ${action.name}.`, { playerId: action.playerId, cardId: action.sourceId })
      } else {
        next.stackSequence += 1
        next.stack.push({
          id: `stack:${next.turnNumber}:${next.stackSequence}`,
          kind: 'ability',
          controllerId: action.playerId,
          sourceId: action.sourceId,
          name: action.name,
          effects: action.effects.map(cloneEffect),
          targets: (action.targets ?? []).map((target) => ({ ...target })),
          counterable: true,
        })
        addEvent(next, 'activate', `${player.name} activated ${action.name}.`, { playerId: action.playerId, cardId: action.sourceId })
      }
      break
    }
    case 'DECLARE_ATTACKERS': {
      const defender = action.defenderId ?? nextPlayerId(next, action.playerId)
      next.combat.defendingPlayerId = defender
      next.combat.attackers = [...action.attackerIds]
      next.combat.attackersDeclared = true
      for (const id of action.attackerIds) {
        const card = next.cards[id]
        card.attacking = true
        if (!hasKeyword(card, 'vigilance')) card.tapped = true
      }
      // Minimal, Embercleave-shaped piece of the eventual general "attacks" trigger system (ROADMAP
      // Phase 4's oracle-pipeline item, out of scope this pass): equipment flagged
      // attachOnAttackerDeclared auto-attaches to an attacking creature for free. Multiple simultaneous
      // triggers aren't modeled - it simply lands on the first declared attacker.
      if (action.attackerIds.length) {
        for (const equipmentId of player.zones.battlefield) {
          const equipment = next.cards[equipmentId]
          if (!equipment?.attachOnAttackerDeclared) continue
          if (equipment.attachedToId && action.attackerIds.includes(equipment.attachedToId)) continue
          const attackerId = action.attackerIds[0]
          equipment.attachedToId = attackerId
          addEvent(next, 'attach', `${equipment.name} attached to ${next.cards[attackerId]?.name ?? 'an attacker'} for free.`, { playerId: action.playerId, cardId: equipmentId })
        }
      }
      next.priorityPlayerId = action.playerId
      next.consecutivePasses = 0
      addEvent(next, 'attackers', `${player.name} declared ${action.attackerIds.length} attacker(s).`, { playerId: action.playerId })
      break
    }
    case 'DECLARE_BLOCKERS': {
      next.combat.blockers = Object.fromEntries(Object.entries(action.assignments).map(([id, blockers]) => [id, [...blockers]]))
      next.combat.blockersDeclared = true
      for (const [attackerId, blockerIds] of Object.entries(action.assignments)) {
        for (const blockerId of blockerIds) next.cards[blockerId].blocking = attackerId
      }
      next.priorityPlayerId = next.activePlayerId
      next.consecutivePasses = 0
      addEvent(next, 'blockers', `${player.name} declared blockers.`, { playerId: action.playerId })
      break
    }
    case 'ORDER_BLOCKERS': {
      next.combat.blockers[action.attackerId] = [...action.order]
      next.consecutivePasses = 0
      addEvent(next, 'order_blockers', `${player.name} set the damage order for ${next.cards[action.attackerId]?.name ?? 'an attacker'}.`, { playerId: action.playerId, cardId: action.attackerId })
      break
    }
    case 'DISCARD_CARDS': {
      for (const cardId of action.cardIds) moveCard(next, cardId, action.playerId, 'graveyard')
      next.pendingDiscard = null
      addEvent(next, 'discard', `${player.name} discarded ${action.cardIds.length} card(s) to the maximum hand size.`, { playerId: action.playerId })
      break
    }
    case 'PASS_PRIORITY':
      handlePass(next, action.playerId)
      break
    case 'ADVANCE_PHASE':
      advancePhase(next)
      break
  }
  return { state: runStateBasedActions(next), accepted: true }
}

function handlePass(state: GameState, playerId: PlayerId): void {
  state.consecutivePasses += 1
  addEvent(state, 'pass', `${state.players[playerId].name} passed priority.`, { playerId })
  const living = alivePlayers(state)
  if (state.consecutivePasses >= living.length) {
    state.consecutivePasses = 0
    if (state.stack.length) {
      resolveTopMutable(state)
      state.priorityPlayerId = state.activePlayerId
    } else {
      advancePhase(state)
    }
    return
  }
  state.priorityPlayerId = nextPlayerId(state, playerId)
}

export function resolveTopOfStack(state: GameState): GameState {
  const next = cloneState(state)
  next.consecutivePasses = 0
  resolveTopMutable(next)
  next.priorityPlayerId = next.activePlayerId
  return runStateBasedActions(next)
}

function resolveTopMutable(state: GameState): void {
  const item = state.stack.pop()
  if (!item) return
  applyEffects(state, item.effects, item.targets, item.controllerId, item.sourceId)
  if (item.kind === 'spell' && item.cardId) {
    const card = state.cards[item.cardId]
    const isPermanent = card.types.some((type) => PERMANENT_TYPES.has(type))
    const destination: ZoneName = isPermanent ? 'battlefield' : 'graveyard'
    state.players[isPermanent ? item.controllerId : card.ownerId].zones[destination].push(item.cardId)
    if (isPermanent) {
      card.controllerId = item.controllerId
      card.enteredTurn = state.turnNumber
      card.summoningSick = card.types.includes('creature')
      card.tapped = false
      enqueueEntersTrigger(state, card, item.controllerId, item.targets)
    }
  }
  addEvent(state, 'resolve', `${item.name} resolved.`, { playerId: item.controllerId, cardId: item.sourceId })
}

function enqueueEntersTrigger(state: GameState, card: CardInstance, controllerId: PlayerId, targets: TargetRef[]): void {
  if (!card.entersEffects?.length) return
  state.stackSequence += 1
  state.stack.push({
    id: `stack:${state.turnNumber}:${state.stackSequence}`,
    kind: 'ability',
    controllerId,
    sourceId: card.instanceId,
    name: `${card.name} enters the battlefield`,
    effects: card.entersEffects.map(cloneEffect),
    targets: targets.map((target) => ({ ...target })),
    counterable: true,
  })
  addEvent(state, 'trigger', `${card.name}'s enter-the-battlefield ability triggered.`, { playerId: controllerId, cardId: card.instanceId })
}

function resolveTarget(target: EffectTarget, targets: TargetRef[]): TargetRef | undefined {
  return target.kind === 'target-slot' ? targets[target.index] : target
}

function applyEffects(
  state: GameState,
  effects: EngineEffect[],
  targets: TargetRef[],
  controllerId: PlayerId,
  sourceId: CardInstanceId,
): void {
  for (const effect of effects) {
    if (effect.type === 'draw') {
      drawCards(state, effect.playerId ?? controllerId, Math.max(0, effect.amount))
      continue
    }
    if (effect.type === 'gain_life' || effect.type === 'lose_life') {
      const player = state.players[effect.playerId ?? controllerId]
      if (player) player.life += effect.type === 'gain_life' ? effect.amount : -effect.amount
      continue
    }
    if (effect.type === 'add_mana') {
      const player = state.players[effect.playerId ?? controllerId]
      if (player) for (const color of COLORS) player.manaPool[color] += effect.mana[color] ?? 0
      continue
    }
    if (effect.type === 'create_token') {
      const playerId = effect.playerId ?? controllerId
      for (let index = 0; index < Math.max(0, effect.amount); index += 1) {
        state.stackSequence += 1
        const id = `token:${state.turnNumber}:${state.stackSequence}`
        const token = makeInstance(effect.token, id, playerId, state.turnNumber, true)
        state.cards[id] = token
        state.players[playerId].zones.battlefield.push(id)
        enqueueEntersTrigger(state, token, playerId, [])
      }
      continue
    }
    const target = resolveTarget(effect.target, targets)
    if (!target) continue
    if (effect.target.kind === 'target-slot' && !matchesTargetRestriction(state, target, effect.target.restriction, controllerId)) continue
    if (effect.type === 'counter_stack_item' && target.kind === 'stack') {
      const index = state.stack.findIndex((item) => item.id === target.stackItemId && item.counterable)
      if (index >= 0) {
        const [countered] = state.stack.splice(index, 1)
        if (countered.kind === 'spell' && countered.cardId) state.players[state.cards[countered.cardId].ownerId].zones.graveyard.push(countered.cardId)
        addEvent(state, 'counter', `${countered.name} was countered.`, { playerId: controllerId, cardId: countered.sourceId })
      }
      continue
    }
    if (target.kind === 'player') {
      if (effect.type === 'damage') {
        state.players[target.playerId].life -= effect.amount
        grantLifelink(state, effect.sourceId ?? sourceId, controllerId, effect.amount)
      }
      continue
    }
    if (target.kind !== 'permanent') continue
    const card = state.cards[target.cardId]
    const location = locateCard(state, target.cardId)
    if (!card || location?.zone !== 'battlefield') continue
    switch (effect.type) {
      case 'damage':
        card.damageMarked += effect.amount
        if (hasKeyword(state.cards[effect.sourceId ?? sourceId], 'deathtouch') && effect.amount > 0) card.counters.__deathtouch_damage = 1
        grantLifelink(state, effect.sourceId ?? sourceId, controllerId, effect.amount)
        break
      case 'modify_stats':
        card.temporaryPower += effect.power
        card.temporaryToughness += effect.toughness
        break
      case 'tap':
        card.tapped = true
        break
      case 'untap':
        card.tapped = false
        break
      case 'destroy':
        if (!hasKeyword(card, 'indestructible')) moveCard(state, card.instanceId, card.ownerId, 'graveyard')
        break
      case 'exile':
        moveCard(state, card.instanceId, card.ownerId, 'exile')
        break
      case 'return_to_hand':
        moveCard(state, card.instanceId, card.ownerId, 'hand')
        break
      case 'add_counter':
        card.counters[effect.counter] = (card.counters[effect.counter] ?? 0) + effect.amount
        break
      case 'remove_counter':
        card.counters[effect.counter] = Math.max(0, (card.counters[effect.counter] ?? 0) - effect.amount)
        break
      case 'attach':
        // sourceId is the Equipment/Aura being activated/resolved; card is the target permanent it
        // attaches onto (already validated as 'controlled-creature' or similar by matchesTargetRestriction).
        state.cards[sourceId].attachedToId = card.instanceId
        break
      default:
        break
    }
  }
}

function grantLifelink(state: GameState, sourceId: CardInstanceId, controllerId: PlayerId, amount: number): void {
  const source = state.cards[sourceId]
  if (source && hasKeyword(source, 'lifelink')) state.players[controllerId].life += amount
}

function clearManaPools(state: GameState): void {
  for (const player of Object.values(state.players)) player.manaPool = emptyMana()
}

function advancePhase(state: GameState): void {
  const gate = declarationGate(state)
  if (!gate.legal) return
  clearManaPools(state)
  if (state.phase === 'combat_damage' && state.combat.firstStrikeDamageDealt && !state.combat.damageDealt) {
    const defenderId = state.combat.defendingPlayerId
    if (defenderId) dealCombatDamageRound(state, defenderId, 'regular')
    applyStateBasedActions(state)
    state.combat.damageDealt = true
    state.consecutivePasses = 0
    state.priorityPlayerId = state.activePlayerId
    addEvent(state, 'combat_damage', 'Regular combat damage was dealt.', { playerId: state.activePlayerId })
    return
  }
  const currentIndex = PHASES.indexOf(state.phase)
  if (state.phase === 'cleanup') {
    state.turnNumber += 1
    state.activePlayerId = nextPlayerId(state, state.activePlayerId)
    state.phase = 'untap'
    startUntap(state)
  } else {
    if (state.phase === 'end_combat') clearCombat(state)
    state.phase = PHASES[currentIndex + 1]
  }
  state.consecutivePasses = 0
  state.priorityPlayerId = state.activePlayerId
  enterPhase(state)
  addEvent(state, 'phase', `Turn ${state.turnNumber}: ${state.phase}.`, { playerId: state.activePlayerId })
}

function enterPhase(state: GameState): void {
  if (state.phase === 'untap') startUntap(state)
  if (state.phase === 'draw' && !(state.skipFirstDraw && state.turnNumber === 1)) drawCards(state, state.activePlayerId, 1)
  if (state.phase === 'declare_attackers') {
    state.combat.attackersDeclared = false
    state.combat.defendingPlayerId = nextPlayerId(state, state.activePlayerId)
  }
  if (state.phase === 'declare_blockers') state.combat.blockersDeclared = false
  if (state.phase === 'combat_damage' && !state.combat.damageDealt) beginCombatDamage(state)
  if (state.phase === 'cleanup') cleanupTurn(state)
}

function startUntap(state: GameState): void {
  const player = state.players[state.activePlayerId]
  player.landsPlayedThisTurn = 0
  for (const cardId of player.zones.battlefield) {
    const card = state.cards[cardId]
    card.tapped = false
    if (card.types.includes('creature')) card.summoningSick = false
  }
}

function cleanupTurn(state: GameState): void {
  for (const card of Object.values(state.cards)) {
    card.damageMarked = 0
    card.temporaryPower = 0
    card.temporaryToughness = 0
    delete card.counters.__deathtouch_damage
  }
  clearCombat(state)
  const activePlayer = state.players[state.activePlayerId]
  if (activePlayer && activePlayer.zones.hand.length > MAX_HAND_SIZE) state.pendingDiscard = state.activePlayerId
}

function clearCombat(state: GameState): void {
  for (const card of Object.values(state.cards)) {
    card.attacking = false
    card.blocking = null
  }
  state.combat = emptyCombat()
}

function beginCombatDamage(state: GameState): void {
  const defenderId = state.combat.defendingPlayerId
  if (!defenderId) return
  const combatants = state.combat.attackers.flatMap((attackerId) => [attackerId, ...(state.combat.blockers[attackerId] ?? [])])
  const hasFirstStrikeRound = combatants.some((id) => {
    const card = state.cards[id]
    return card && locateCard(state, id)?.zone === 'battlefield' && (hasKeyword(card, 'first strike') || hasKeyword(card, 'double strike'))
  })
  if (hasFirstStrikeRound) {
    dealCombatDamageRound(state, defenderId, 'first')
    applyStateBasedActions(state)
    state.combat.firstStrikeDamageDealt = true
    addEvent(state, 'first_strike_damage', 'First-strike combat damage was dealt.', { playerId: state.activePlayerId })
  } else {
    dealCombatDamageRound(state, defenderId, 'all')
    applyStateBasedActions(state)
    state.combat.damageDealt = true
    addEvent(state, 'combat_damage', 'Combat damage was dealt.', { playerId: state.activePlayerId })
  }
}

function dealCombatDamageRound(state: GameState, defenderId: PlayerId, round: 'first' | 'regular' | 'all'): void {
  const packets: Array<{ sourceId: CardInstanceId; target: TargetRef; amount: number; deathtouch: boolean }> = []
  for (const attackerId of state.combat.attackers) {
    const attacker = state.cards[attackerId]
    if (!attacker || locateCard(state, attackerId)?.zone !== 'battlefield') continue
    const attackerDeals = round === 'all'
      || (round === 'first' && (hasKeyword(attacker, 'first strike') || hasKeyword(attacker, 'double strike')))
      || (round === 'regular' && (!hasKeyword(attacker, 'first strike') || hasKeyword(attacker, 'double strike')))
    let remainingPower = attackerDeals ? Math.max(0, getPower(attacker)) : 0
    const declaredBlockers = state.combat.blockers[attackerId] ?? []
    const blockers = declaredBlockers.filter((id) => locateCard(state, id)?.zone === 'battlefield')
    if (!declaredBlockers.length && attackerDeals) {
      packets.push({ sourceId: attackerId, target: { kind: 'player', playerId: defenderId }, amount: remainingPower, deathtouch: hasKeyword(attacker, 'deathtouch') })
    } else {
      blockers.forEach((blockerId, index) => {
        const blocker = state.cards[blockerId]
        const lethal = hasKeyword(attacker, 'deathtouch') ? 1 : Math.max(0, getToughness(blocker) - blocker.damageMarked)
        const isLast = index === blockers.length - 1
        const assigned = isLast && !hasKeyword(attacker, 'trample') ? remainingPower : Math.min(remainingPower, lethal)
        if (assigned > 0) packets.push({ sourceId: attackerId, target: { kind: 'permanent', cardId: blockerId }, amount: assigned, deathtouch: hasKeyword(attacker, 'deathtouch') })
        remainingPower -= assigned
      })
      if (remainingPower > 0 && hasKeyword(attacker, 'trample')) packets.push({ sourceId: attackerId, target: { kind: 'player', playerId: defenderId }, amount: remainingPower, deathtouch: false })
      for (const blockerId of blockers) {
        const blocker = state.cards[blockerId]
        const blockerDeals = round === 'all'
          || (round === 'first' && (hasKeyword(blocker, 'first strike') || hasKeyword(blocker, 'double strike')))
          || (round === 'regular' && (!hasKeyword(blocker, 'first strike') || hasKeyword(blocker, 'double strike')))
        if (blockerDeals) packets.push({ sourceId: blockerId, target: { kind: 'permanent', cardId: attackerId }, amount: Math.max(0, getPower(blocker)), deathtouch: hasKeyword(blocker, 'deathtouch') })
      }
    }
  }
  for (const packet of packets) {
    if (packet.target.kind === 'player') state.players[packet.target.playerId].life -= packet.amount
    if (packet.target.kind === 'permanent') {
      const target = state.cards[packet.target.cardId]
      if (target) {
        target.damageMarked += packet.amount
        if (packet.deathtouch && packet.amount > 0) target.counters.__deathtouch_damage = 1
      }
    }
    grantLifelink(state, packet.sourceId, state.cards[packet.sourceId]?.controllerId ?? state.activePlayerId, packet.amount)
  }
}

function applyStateBasedActions(next: GameState): GameState {
  refreshContinuousEffects(next)
  let changed = true
  while (changed) {
    changed = false
    for (const player of Object.values(next.players)) {
      if (player.life <= 0 && !player.lost) {
        player.lost = true
        changed = true
        addEvent(next, 'player_lost', `${player.name} lost the game.`, { playerId: player.id })
      }
    }
    for (const player of Object.values(next.players)) {
      for (const cardId of [...player.zones.battlefield]) {
        const card = next.cards[cardId]
        if (!card) continue
        const opposingCounters = Math.min(card.counters['+1/+1'] ?? 0, card.counters['-1/-1'] ?? 0)
        if (opposingCounters > 0) {
          card.counters['+1/+1'] -= opposingCounters
          card.counters['-1/-1'] -= opposingCounters
          if (card.counters['+1/+1'] === 0) delete card.counters['+1/+1']
          if (card.counters['-1/-1'] === 0) delete card.counters['-1/-1']
          changed = true
        }
        if (!card.types.includes('creature')) continue
        const zeroToughness = getToughness(card) <= 0
        const lethalDamage = card.damageMarked >= getToughness(card) && !hasKeyword(card, 'indestructible')
        const deathtouchDamage = (card.counters.__deathtouch_damage ?? 0) > 0 && !hasKeyword(card, 'indestructible')
        if (zeroToughness || lethalDamage || deathtouchDamage) {
          if (card.token) {
            const index = player.zones.battlefield.indexOf(cardId)
            if (index >= 0) player.zones.battlefield.splice(index, 1)
            delete next.cards[cardId]
          } else {
            moveCard(next, cardId, card.ownerId, 'graveyard')
          }
          changed = true
          addEvent(next, 'creature_died', `${card.name} died.`, { playerId: card.controllerId, cardId })
        }
      }
    }
    for (const player of Object.values(next.players)) {
      const legendaryByName = new Map<string, CardInstanceId[]>()
      for (const cardId of player.zones.battlefield) {
        const card = next.cards[cardId]
        if (!card?.legendary) continue
        const group = legendaryByName.get(card.name) ?? []
        group.push(cardId)
        legendaryByName.set(card.name, group)
      }
      for (const [name, group] of legendaryByName) {
        if (group.length < 2) continue
        // Rule 704.5j: the controller keeps one. No interactive chooser exists yet, so this picks a
        // deterministic "best" copy (most keywords, then highest power, then most recently entered).
        const keeperId = group.reduce((bestId, candidateId) => {
          const best = next.cards[bestId]
          const candidate = next.cards[candidateId]
          const bestScore = (best.keywords ?? []).length
          const candidateScore = (candidate.keywords ?? []).length
          if (candidateScore !== bestScore) return candidateScore > bestScore ? candidateId : bestId
          if (getPower(candidate) !== getPower(best)) return getPower(candidate) > getPower(best) ? candidateId : bestId
          if (candidate.enteredTurn !== best.enteredTurn) return candidate.enteredTurn > best.enteredTurn ? candidateId : bestId
          return candidateId.localeCompare(bestId) > 0 ? candidateId : bestId
        }, group[0])
        for (const cardId of group) {
          if (cardId === keeperId) continue
          const card = next.cards[cardId]
          if (card.token) {
            const index = player.zones.battlefield.indexOf(cardId)
            if (index >= 0) player.zones.battlefield.splice(index, 1)
            delete next.cards[cardId]
          } else {
            moveCard(next, cardId, card.ownerId, 'graveyard')
          }
          changed = true
          addEvent(next, 'legend_rule', `${name} was put into the graveyard because of the legend rule.`, { playerId: player.id, cardId })
        }
      }
    }
    for (const player of Object.values(next.players)) {
      for (const zone of ['library', 'hand', 'graveyard', 'exile', 'command'] as const) {
        for (const cardId of [...player.zones[zone]]) {
          const card = next.cards[cardId]
          if (!card?.token) continue
          player.zones[zone].splice(player.zones[zone].indexOf(cardId), 1)
          delete next.cards[cardId]
          changed = true
          addEvent(next, 'token_ceased', `${card.name} ceased to exist.`, { playerId: card.ownerId, cardId })
        }
      }
    }
  }
  const living = alivePlayers(next)
  if (living.length === 1) {
    next.winnerId = living[0]
    next.priorityPlayerId = null
  } else if (living.length === 0) {
    next.isDraw = true
    next.priorityPlayerId = null
  }
  return next
}

export function runStateBasedActions(state: GameState): GameState {
  return applyStateBasedActions(cloneState(state))
}

export function legalActionsForPlayer(state: GameState, playerId: PlayerId): GameAction[] {
  const player = state.players[playerId]
  if (!player || player.lost || state.priorityPlayerId !== playerId) return []
  const actions: GameAction[] = [{ type: 'PASS_PRIORITY', playerId }]
  for (const cardId of player.zones.hand) {
    const card = state.cards[cardId]
    const action: GameAction = card.types.includes('land')
      ? { type: 'PLAY_LAND', playerId, cardId }
      : { type: 'CAST_SPELL', playerId, cardId }
    if (checkAction(state, action).legal) actions.push(action)
  }
  for (const cardId of player.zones.battlefield) {
    const action: GameAction = { type: 'TAP_FOR_MANA', playerId, cardId }
    if (checkAction(state, action).legal) actions.push(action)
  }
  if (state.phase === 'declare_attackers' && playerId === state.activePlayerId && !state.combat.attackersDeclared) actions.push({ type: 'DECLARE_ATTACKERS', playerId, attackerIds: [] })
  if (state.phase === 'declare_blockers' && playerId === state.combat.defendingPlayerId && !state.combat.blockersDeclared) actions.push({ type: 'DECLARE_BLOCKERS', playerId, assignments: {} })
  return actions
}

export function reduceActions(initialState: GameState, actions: GameAction[]): ActionResult {
  let state = initialState
  for (const action of actions) {
    const result = gameReducer(state, action)
    if (!result.accepted) return result
    state = result.state
  }
  return { state, accepted: true }
}

export function getPhaseLabel(phase: GamePhase): string {
  return ({
    untap: 'Untap',
    upkeep: 'Upkeep',
    draw: 'Draw',
    main1: 'Main 1',
    begin_combat: 'Begin Combat',
    declare_attackers: 'Declare Attackers',
    declare_blockers: 'Declare Blockers',
    combat_damage: 'Combat Damage',
    end_combat: 'End Combat',
    main2: 'Main 2',
    end: 'End',
    cleanup: 'Cleanup',
  } satisfies Record<GamePhase, string>)[phase]
}
