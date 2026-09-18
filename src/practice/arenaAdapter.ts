import type { CatalogCard, SavedDeck } from '../catalog'
import { expandDeckCards } from '../catalog'
import {
  anyLegalTargetExists,
  canPayMana,
  checkAction,
  createGame,
  entersTargetSlotIndices,
  gameReducer,
  getManaProduction,
  getPower,
  getToughness,
  matchesTargetRestriction,
  type ActionResult,
  type CardDefinition,
  type CardInstance,
  type CardInstanceId,
  type CardType,
  type EngineEffect,
  type GameAction,
  type GameState,
  type ManaColor,
  type PlayerId,
  type TargetRef,
  type TargetRestriction,
} from '../engine'
import { parseOracleText, type OracleAction, type OracleAmount } from '../services/scryfall'
import type { CardColor, CardData, CardKind, GameLogItem, Phase } from '../types'

export const HUMAN_PLAYER_ID = 'you'
export const BOT_PLAYER_ID = 'bot'

const MANA_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']
const CARD_TYPES: CardType[] = ['artifact', 'battle', 'creature', 'enchantment', 'instant', 'land', 'planeswalker', 'sorcery', 'tribal']

function numericAmount(amount: OracleAmount): number | null {
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null
}

function normalizeKeyword(keyword: string): string {
  return keyword.replaceAll('-', ' ').toLocaleLowerCase()
}

function cardTypes(card: CatalogCard): CardType[] {
  const typeLine = card.typeLine.toLocaleLowerCase()
  const matches = CARD_TYPES.filter((type) => new RegExp(`\\b${type}\\b`, 'i').test(typeLine))
  if (matches.length) return matches
  return [card.kind]
}

function manaProduction(card: CatalogCard): Partial<Record<ManaColor, number>> | undefined {
  const result: Partial<Record<ManaColor, number>> = {}
  // Lands' mana abilities can use "Add {X} or {Y}" alternation (e.g. Rockfall Vale); other cards keep the
  // stricter "add" immediately before the symbol so a combat trigger like "add {R} or {G}" (Kessig
  // Naturalist) isn't mistaken for a tap-for-mana ability.
  const pattern = card.kind === 'land'
    ? /add\s+\{([WUBRGC])\}(?:\s+or\s+\{([WUBRGC])\})?/gi
    : /add\s+\{([WUBRGC])\}/gi
  for (const match of card.rules.matchAll(pattern)) {
    for (const group of match.slice(1)) {
      if (!group) continue
      const color = group.toLocaleUpperCase() as ManaColor
      result[color] = Math.max(1, result[color] ?? 0)
    }
  }
  if (card.kind === 'land' && !Object.keys(result).length) {
    for (const symbol of card.mana.toLocaleUpperCase().match(/[WUBRGC]/g) ?? []) {
      result[symbol as ManaColor] = 1
    }
  }
  return Object.keys(result).length ? result : undefined
}

function tokenDefinition(action: Extract<OracleAction, { kind: 'create-token' }>): CardDefinition {
  const stats = action.token.match(/(\d+)\s*\/\s*(\d+)/)
  const name = action.token
    .replace(/\b\d+\s*\/\s*\d+\b/g, '')
    .replace(/\b(?:white|blue|black|red|green|colorless|artifact|creature|with.*)$/i, '')
    .trim() || 'Token'
  return {
    id: `token-${name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    types: action.token.toLocaleLowerCase().includes('artifact') ? ['artifact', 'creature'] : ['creature'],
    typeLine: action.token,
    power: stats ? Number(stats[1]) : 1,
    toughness: stats ? Number(stats[2]) : 1,
  }
}

function actionNeedsTarget(action: OracleAction): boolean {
  return [
    'any-target',
    'target-player',
    'target-creature',
    'opponent-creature',
    'target-permanent',
    'target-spell',
    'controlled-creature',
  ].includes(action.target)
}

function restrictionForAction(action: OracleAction): TargetRestriction | undefined {
  if (action.target === 'any-target') return 'any-target'
  if (action.target === 'target-player') return 'player'
  if (action.target === 'opponent') return 'opponent'
  if (action.target === 'target-creature') return 'creature'
  if (action.target === 'opponent-creature') return 'opponent-creature'
  if (action.target === 'controlled-creature') return 'controlled-creature'
  if (action.target === 'target-spell') return 'spell'
  if (action.target !== 'target-permanent') return undefined

  const text = action.sourceText.toLocaleLowerCase()
  if (/\btarget artifact or enchantment\b|\btarget enchantment or artifact\b/.test(text)) return 'artifact-or-enchantment'
  if (/\btarget artifact\b/.test(text)) return 'artifact'
  if (/\btarget enchantment\b/.test(text)) return 'enchantment'
  if (/\btarget planeswalker\b/.test(text)) return 'planeswalker'
  if (/\btarget battle\b/.test(text)) return 'battle'
  if (/\btarget land\b/.test(text)) return 'land'
  return 'permanent'
}

function toEngineEffect(action: OracleAction, targetIndex: number | null): EngineEffect | null {
  const target = targetIndex === null ? null : { kind: 'target-slot' as const, index: targetIndex, restriction: restrictionForAction(action) }
  switch (action.kind) {
    case 'deal-damage': {
      const amount = numericAmount(action.amount)
      return amount !== null && target ? { type: 'damage', amount, target } : null
    }
    case 'draw-cards': {
      const amount = numericAmount(action.amount)
      return amount !== null && ['you', 'unspecified'].includes(action.target) ? { type: 'draw', amount } : null
    }
    case 'gain-life': {
      const amount = numericAmount(action.amount)
      return amount !== null && ['you', 'unspecified'].includes(action.target) ? { type: 'gain_life', amount } : null
    }
    case 'lose-life': {
      const amount = numericAmount(action.amount)
      return amount !== null && ['you', 'unspecified'].includes(action.target) ? { type: 'lose_life', amount } : null
    }
    case 'add-mana': {
      const amount = numericAmount(action.amount) ?? 1
      const mana: Partial<Record<ManaColor, number>> = {}
      const symbol = action.mana.find((value) => MANA_COLORS.includes(value as ManaColor)) as ManaColor | undefined
      if (!symbol) return null
      mana[symbol] = amount
      return { type: 'add_mana', mana }
    }
    case 'modify-stats': {
      const power = numericAmount(action.power)
      const toughness = numericAmount(action.toughness)
      return power !== null && toughness !== null && target
        ? { type: 'modify_stats', power, toughness, target, untilEndOfTurn: action.duration === 'end-of-turn' }
        : null
    }
    case 'destroy':
      return target ? { type: 'destroy', target } : null
    case 'exile':
      return target ? { type: 'exile', target } : null
    case 'tap':
      return target ? { type: 'tap', target } : null
    case 'untap':
      return target ? { type: 'untap', target } : null
    case 'counter-spell':
      return target ? { type: 'counter_stack_item', target } : null
    case 'put-counters': {
      const amount = numericAmount(action.amount)
      return amount !== null && target ? { type: 'add_counter', amount, counter: action.counter, target } : null
    }
    case 'return-to-zone':
      if (!target) return null
      if (action.zone === 'hand') return { type: 'return_to_hand', target }
      if (action.zone === 'battlefield' || action.zone === 'library' || action.zone === 'graveyard') return null
      return null
    case 'create-token': {
      const amount = numericAmount(action.amount)
      return amount !== null ? { type: 'create_token', amount, token: tokenDefinition(action) } : null
    }
    default:
      return null
  }
}

/**
 * Builds what an Equipment/Aura-style permanent grants to whatever it's attached to, from any parsed
 * oracle actions targeting 'equipped-creature' (e.g. "Equipped creature gets +1/+1 and has double
 * strike and trample"). Generic over any card shaped like this - not specific to Embercleave.
 */
function attachGrantFromParsedActions(actions: OracleAction[]): { power?: number; toughness?: number; keywords?: string[] } | undefined {
  const relevant = actions.filter((action) => action.target === 'equipped-creature')
  if (!relevant.length) return undefined
  let power: number | undefined
  let toughness: number | undefined
  const keywords: string[] = []
  for (const action of relevant) {
    if (action.kind === 'modify-stats' && action.duration === 'continuous') {
      const p = numericAmount(action.power)
      const t = numericAmount(action.toughness)
      if (p !== null) power = (power ?? 0) + p
      if (t !== null) toughness = (toughness ?? 0) + t
    } else if (action.kind === 'keyword') {
      keywords.push(normalizeKeyword(action.keyword))
    }
  }
  if (power === undefined && toughness === undefined && !keywords.length) return undefined
  return { power, toughness, keywords: keywords.length ? keywords : undefined }
}

/**
 * Whether this card's oracle text is the Embercleave-shaped "Whenever a creature you control attacks,
 * equip [this] onto it for free." This is a narrow, one-off pattern match, not a general "attacks"
 * trigger - see ROADMAP Phase 4 (the oracle-pipeline generalization pass is explicitly out of scope
 * here; this is deliberately the minimal piece needed for Embercleave's free-equip trigger to work).
 */
function hasFreeEquipOnAttackTrigger(rulesText: string): boolean {
  return /\bwhenever a creature you control attacks\b/i.test(rulesText)
    && /\bequip\b[^.]*\bonto (?:it|that creature)\b[^.]*\bfor free\b/i.test(rulesText)
}

export function catalogCardToDefinition(card: CatalogCard): CardDefinition {
  const defaultTrigger = /\b(?:Instant|Sorcery)\b/i.test(card.typeLine) ? 'spell-resolution' : 'static'
  const parsed = parseOracleText(card.rules, card.name, defaultTrigger)
  const targetSlots = new Map<string, number>()
  const mapActions = (actions: OracleAction[]) => actions.flatMap((action) => {
    let targetIndex: number | null = null
    if (actionNeedsTarget(action)) {
      const key = `${action.trigger}:${action.target}`
      targetIndex = targetSlots.get(key) ?? targetSlots.size
      targetSlots.set(key, targetIndex)
    } else if (action.kind === 'deal-damage' && action.target === 'opponent') {
      const key = `${action.trigger}:opponent`
      targetIndex = targetSlots.get(key) ?? targetSlots.size
      targetSlots.set(key, targetIndex)
    }
    const effect = toEngineEffect(action, targetIndex)
    return effect ? [effect] : []
  })
  const effects = mapActions(parsed.actions.filter((action) => action.trigger === 'spell-resolution'))
  const entersEffects = mapActions(parsed.actions.filter((action) => action.trigger === 'enters'))

  const equipKeywordAction = parsed.actions.find((action): action is Extract<OracleAction, { kind: 'keyword' }> => action.kind === 'keyword' && action.keyword === 'equip')
  const equip = equipKeywordAction?.value ? { cost: equipKeywordAction.value } : undefined
  const attachGrant = attachGrantFromParsedActions(parsed.actions)
  const attachOnAttackerDeclared = hasFreeEquipOnAttackTrigger(card.rules) || undefined

  return {
    id: card.id,
    name: card.name,
    types: cardTypes(card),
    typeLine: card.typeLine,
    manaCost: card.kind === 'land' ? undefined : card.mana,
    manaValue: card.cost,
    oracleText: card.rules,
    keywords: parsed.keywords.map(normalizeKeyword),
    power: card.power,
    toughness: card.toughness,
    producesMana: manaProduction(card),
    effects,
    entersEffects,
    imageUri: card.image,
    legendary: /\blegendary\b/i.test(card.typeLine),
    equip,
    attachGrant,
    attachOnAttackerDeclared,
  }
}

export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

export function createPracticeGame(deck: SavedDeck, rivalDeck: SavedDeck, random: () => number = Math.random): GameState {
  const playerDeck = shuffled(expandDeckCards(deck).map(catalogCardToDefinition), random)
  const botCards = shuffled(expandDeckCards(rivalDeck).map(catalogCardToDefinition), random)
  return createGame({
    players: [
      { id: HUMAN_PLAYER_ID, name: 'YOU', deck: playerDeck },
      { id: BOT_PLAYER_ID, name: 'VEX_MAGE', deck: botCards },
    ],
    startingPlayerId: HUMAN_PLAYER_ID,
    startingLife: 20,
    openingHandSize: 7,
    skipFirstDraw: true,
  })
}

function appendPregameEvent(state: GameState, type: string, message: string, playerId: PlayerId): void {
  state.eventSequence += 1
  state.events.push({ id: state.eventSequence, turn: state.turnNumber, phase: state.phase, type, message, playerId })
}

export function takeLondonMulligan(state: GameState, playerId: PlayerId, random: () => number = Math.random): GameState {
  const next = structuredClone(state)
  const player = next.players[playerId]
  if (!player) return state
  player.zones.library = shuffled([...player.zones.library, ...player.zones.hand], random)
  player.zones.hand = player.zones.library.splice(0, 7)
  appendPregameEvent(next, 'mulligan', `${player.name} took a mulligan.`, playerId)
  return next
}

export function bottomOpeningCards(state: GameState, playerId: PlayerId, cardIds: readonly CardInstanceId[], expectedCount: number): ActionResult {
  const player = state.players[playerId]
  const unique = [...new Set(cardIds)]
  if (!player || unique.length !== expectedCount || unique.some((id) => !player.zones.hand.includes(id))) {
    return { state, accepted: false, error: `Choose exactly ${expectedCount} card${expectedCount === 1 ? '' : 's'} from the opening hand.` }
  }
  const next = structuredClone(state)
  const nextPlayer = next.players[playerId]
  nextPlayer.zones.hand = nextPlayer.zones.hand.filter((id) => !unique.includes(id))
  nextPlayer.zones.library.push(...unique)
  appendPregameEvent(next, 'bottom_cards', `${nextPlayer.name} put ${expectedCount} card${expectedCount === 1 ? '' : 's'} on the bottom.`, playerId)
  return { state: next, accepted: true }
}

function colorFromCard(card: CardInstance): CardColor {
  const symbols = new Set((card.manaCost ?? '').toLocaleUpperCase().match(/[WUBRG]/g) ?? [])
  if (!symbols.size && card.producesMana) {
    MANA_COLORS.forEach((color) => {
      if (color !== 'C' && (card.producesMana?.[color] ?? 0) > 0) symbols.add(color)
    })
  }
  if (symbols.size > 1) return 'gold'
  if (symbols.has('W')) return 'white'
  if (symbols.has('U')) return 'blue'
  if (symbols.has('B')) return 'black'
  if (symbols.has('R')) return 'red'
  if (symbols.has('G')) return 'green'
  return 'colorless'
}

function kindFromCard(card: CardInstance): CardKind {
  if (card.types.includes('land')) return 'land'
  if (card.types.includes('creature')) return 'creature'
  if (card.types.includes('instant')) return 'instant'
  if (card.types.includes('sorcery')) return 'sorcery'
  if (card.types.includes('planeswalker')) return 'planeswalker'
  if (card.types.includes('enchantment')) return 'enchantment'
  if (card.types.includes('battle')) return 'battle'
  return 'artifact'
}

export function engineCardToView(card: CardInstance): CardData {
  const powerAdjustment = getPower(card) - (card.power ?? 0)
  const toughnessAdjustment = getToughness(card) - (card.toughness ?? 0)
  return {
    uid: card.instanceId,
    oracleName: card.name,
    name: card.name,
    kind: kindFromCard(card),
    color: colorFromCard(card),
    cost: card.manaValue ?? 0,
    mana: card.manaCost,
    typeLine: card.typeLine ?? card.types.join(' '),
    rules: card.oracleText ?? '',
    power: card.power,
    toughness: card.toughness,
    image: card.imageUri ?? '/cards/questing-beast.jpg',
    tapped: card.tapped,
    attacking: card.attacking,
    summoningSick: card.summoningSick,
    buff: powerAdjustment === toughnessAdjustment && powerAdjustment !== 0 ? powerAdjustment : undefined,
    equipCost: card.equip?.cost,
    attachedToId: card.attachedToId,
  }
}

export function zoneCards(state: GameState, playerId: PlayerId, zone: keyof GameState['players'][string]['zones']): CardData[] {
  return state.players[playerId].zones[zone].map((id) => engineCardToView(state.cards[id])).filter(Boolean)
}

export function arenaPhase(phase: GameState['phase']): Phase {
  if (phase === 'untap' || phase === 'upkeep') return 'untap'
  if (phase === 'draw') return 'draw'
  if (phase === 'main1') return 'main'
  if (['begin_combat', 'declare_attackers', 'declare_blockers', 'combat_damage', 'end_combat'].includes(phase)) return 'combat'
  if (phase === 'main2') return 'second'
  return 'end'
}

export function eventTone(type: string): GameLogItem['tone'] {
  if (['damage', 'combat_damage', 'player_lost', 'creature_died'].includes(type)) return 'damage'
  if (['cast', 'resolve', 'counter', 'draw'].includes(type)) return 'spell'
  return 'default'
}

export function eventsToLog(state: GameState): GameLogItem[] {
  return state.events.slice(-60).map((event) => ({ id: event.id, text: event.message, tone: eventTone(event.type) }))
}

export function requiredTargetCount(card: CardInstance): number {
  let count = 0
  for (const effect of [...(card.effects ?? []), ...(card.entersEffects ?? [])]) {
    if ('target' in effect && effect.target.kind === 'target-slot') count = Math.max(count, effect.target.index + 1)
  }
  return count
}

/**
 * The number of targets that actually must be supplied to cast this card right now. Differs from
 * requiredTargetCount() when a target slot only comes from an enters-the-battlefield trigger (e.g.
 * Reclamation Sage's "destroy target artifact or enchantment") and no legal target currently exists -
 * rule 603.3c lets that trigger simply fizzle instead of blocking the cast.
 */
export function castTargetCount(state: GameState, playerId: PlayerId, card: CardInstance): number {
  const softIndices = entersTargetSlotIndices(card)
  let count = 0
  for (const effect of [...(card.effects ?? []), ...(card.entersEffects ?? [])]) {
    if (!('target' in effect) || effect.target.kind !== 'target-slot') continue
    const index = effect.target.index
    if (softIndices.has(index) && !anyLegalTargetExists(state, effect.target.restriction, playerId)) continue
    count = Math.max(count, index + 1)
  }
  return count
}

function manaStateKey(state: GameState, playerId: PlayerId): string {
  const player = state.players[playerId]
  const tapped = player.zones.battlefield.filter((id) => state.cards[id].tapped).sort().join(',')
  return `${MANA_COLORS.map((color) => player.manaPool[color]).join(',')}|${tapped}`
}

export function findManaActions(state: GameState, playerId: PlayerId, cost: string | undefined): GameAction[] | null {
  if (canPayMana(state.players[playerId].manaPool, cost)) return []
  const visited = new Set<string>()
  const search = (current: GameState, actions: GameAction[]): GameAction[] | null => {
    const key = manaStateKey(current, playerId)
    if (visited.has(key)) return null
    visited.add(key)
    if (canPayMana(current.players[playerId].manaPool, cost)) return actions

    for (const cardId of current.players[playerId].zones.battlefield) {
      const production = getManaProduction(current.cards[cardId])
      for (const color of MANA_COLORS) {
        if ((production[color] ?? 0) <= 0) continue
        const action: GameAction = { type: 'TAP_FOR_MANA', playerId, cardId, color }
        if (!checkAction(current, action).legal) continue
        const result = gameReducer(current, action)
        if (!result.accepted) continue
        const found = search(result.state, [...actions, action])
        if (found) return found
      }
    }
    return null
  }
  return search(state, [])
}

export interface ArenaDispatchResult extends ActionResult {
  actions: GameAction[]
}

export function castWithAutomaticMana(state: GameState, playerId: PlayerId, cardId: CardInstanceId, targets: TargetRef[] = []): ArenaDispatchResult {
  const card = state.cards[cardId]
  if (!card || !state.players[playerId]?.zones.hand.includes(cardId)) {
    return { state, accepted: false, error: 'That card is not in your hand.', actions: [] }
  }
  if (targets.length < castTargetCount(state, playerId, card)) {
    return { state, accepted: false, error: 'Choose all required targets before casting.', actions: [] }
  }
  const manaActions = findManaActions(state, playerId, card.manaCost)
  if (!manaActions) return { state, accepted: false, error: `You cannot produce the mana required for ${card.name}.`, actions: [] }

  let current = state
  for (const action of manaActions) {
    const result = gameReducer(current, action)
    if (!result.accepted) return { state, accepted: false, error: result.error, actions: [] }
    current = result.state
  }
  const castAction: GameAction = { type: 'CAST_SPELL', playerId, cardId, targets }
  const castResult = gameReducer(current, castAction)
  if (!castResult.accepted) return { state, accepted: false, error: castResult.error, actions: [] }
  return { ...castResult, actions: [...manaActions, castAction] }
}

/**
 * Manually equips an Equipment permanent onto a creature the player controls, auto-tapping mana for its
 * equip cost. Equip is sorcery-speed only and never taps the equipment itself (rule 702.6e); this
 * resolves immediately rather than going on the stack, a simplification reasonable for an ability with
 * no meaningful response window in this engine.
 */
export function equipWithAutomaticMana(state: GameState, playerId: PlayerId, equipmentId: CardInstanceId, creatureId: CardInstanceId): ArenaDispatchResult {
  const equipment = state.cards[equipmentId]
  if (!equipment?.equip) return { state, accepted: false, error: 'That permanent has no equip ability.', actions: [] }
  const manaActions = findManaActions(state, playerId, equipment.equip.cost)
  if (!manaActions) return { state, accepted: false, error: `You cannot produce the mana required to equip ${equipment.name}.`, actions: [] }

  let current = state
  for (const action of manaActions) {
    const result = gameReducer(current, action)
    if (!result.accepted) return { state, accepted: false, error: result.error, actions: [] }
    current = result.state
  }
  const equipAction: GameAction = {
    type: 'ACTIVATE_ABILITY',
    playerId,
    sourceId: equipmentId,
    name: `Equip ${equipment.name}`,
    effects: [{ type: 'attach', target: { kind: 'target-slot', index: 0, restriction: 'controlled-creature' } }],
    targets: [{ kind: 'permanent', cardId: creatureId }],
    manaCost: equipment.equip.cost,
    sorcerySpeedOnly: true,
    manaAbility: true,
  }
  const equipResult = gameReducer(current, equipAction)
  if (!equipResult.accepted) return { state, accepted: false, error: equipResult.error, actions: [] }
  return { ...equipResult, actions: [...manaActions, equipAction] }
}

export function legalAttackers(state: GameState, playerId: PlayerId): CardInstanceId[] {
  if (state.phase !== 'declare_attackers' || state.activePlayerId !== playerId || state.combat.attackersDeclared) return []
  return state.players[playerId].zones.battlefield.filter((cardId) => {
    const action: GameAction = { type: 'DECLARE_ATTACKERS', playerId, attackerIds: [cardId] }
    return checkAction(state, action).legal
  })
}

export function legalTargets(state: GameState, playerId: PlayerId, cardId: CardInstanceId, selected: readonly TargetRef[] = []): TargetRef[] {
  const card = state.cards[cardId]
  if (!card) return []
  const slot = selected.length
  if (slot >= castTargetCount(state, playerId, card)) return []
  const relevant = [...(card.effects ?? []), ...(card.entersEffects ?? [])].filter((effect) => 'target' in effect && effect.target.kind === 'target-slot' && effect.target.index === slot)
  const needsStack = relevant.some((effect) => effect.type === 'counter_stack_item')
  const needsPermanent = relevant.some((effect) => ['destroy', 'exile', 'return_to_hand', 'tap', 'untap', 'modify_stats', 'add_counter', 'remove_counter'].includes(effect.type))
  if (needsStack) return state.stack
    .filter((item) => item.counterable)
    .map((item) => ({ kind: 'stack' as const, stackItemId: item.id }))
    .filter((target) => relevant.every((effect) => !('target' in effect) || effect.target.kind !== 'target-slot' || matchesTargetRestriction(state, target, effect.target.restriction, playerId)))
  const permanents: TargetRef[] = state.playerOrder.flatMap((id) => state.players[id].zones.battlefield.map((id) => ({ kind: 'permanent' as const, cardId: id })))
  const candidates = needsPermanent
    ? permanents
    : [...permanents, ...state.playerOrder.filter((id) => !state.players[id].lost).map((id) => ({ kind: 'player' as const, playerId: id }))]
  return candidates.filter((target) => relevant.every((effect) => !('target' in effect) || effect.target.kind !== 'target-slot' || matchesTargetRestriction(state, target, effect.target.restriction, playerId)))
}
