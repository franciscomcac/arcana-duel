export const PHASES = [
  'untap',
  'upkeep',
  'draw',
  'main1',
  'begin_combat',
  'declare_attackers',
  'declare_blockers',
  'combat_damage',
  'end_combat',
  'main2',
  'end',
  'cleanup',
] as const

export type GamePhase = (typeof PHASES)[number]
export type PlayerId = string
export type CardInstanceId = string
export type StackItemId = string
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'
export type ManaPool = Record<ManaColor, number>
export type ZoneName = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'
export type CardType =
  | 'artifact'
  | 'battle'
  | 'creature'
  | 'enchantment'
  | 'instant'
  | 'land'
  | 'planeswalker'
  | 'sorcery'
  | 'tribal'

export type Keyword =
  | 'deathtouch'
  | 'defender'
  | 'double strike'
  | 'first strike'
  | 'flash'
  | 'flying'
  | 'haste'
  | 'hexproof'
  | 'indestructible'
  | 'lifelink'
  | 'menace'
  | 'reach'
  | 'trample'
  | 'vigilance'
  | string

export interface PlayerTarget {
  kind: 'player'
  playerId: PlayerId
}

export interface PermanentTarget {
  kind: 'permanent'
  cardId: CardInstanceId
}

export interface StackTarget {
  kind: 'stack'
  stackItemId: StackItemId
}

export type TargetRef = PlayerTarget | PermanentTarget | StackTarget

export type TargetRestriction =
  | 'any-target'
  | 'player'
  | 'opponent'
  | 'creature'
  | 'controlled-creature'
  | 'permanent'
  | 'artifact'
  | 'enchantment'
  | 'artifact-or-enchantment'
  | 'planeswalker'
  | 'battle'
  | 'land'
  | 'spell'

export interface TargetSlot {
  kind: 'target-slot'
  index: number
  restriction?: TargetRestriction
}

export type EffectTarget = TargetRef | TargetSlot

export type EngineEffect =
  | { type: 'damage'; amount: number; target: EffectTarget; sourceId?: CardInstanceId }
  | { type: 'draw'; amount: number; playerId?: PlayerId }
  | { type: 'gain_life'; amount: number; playerId?: PlayerId }
  | { type: 'lose_life'; amount: number; playerId?: PlayerId }
  | { type: 'add_mana'; mana: Partial<ManaPool>; playerId?: PlayerId }
  | { type: 'modify_stats'; power: number; toughness: number; target: EffectTarget; untilEndOfTurn?: boolean }
  | { type: 'tap'; target: EffectTarget }
  | { type: 'untap'; target: EffectTarget }
  | { type: 'destroy'; target: EffectTarget }
  | { type: 'exile'; target: EffectTarget }
  | { type: 'return_to_hand'; target: EffectTarget }
  | { type: 'add_counter'; counter: string; amount: number; target: EffectTarget }
  | { type: 'remove_counter'; counter: string; amount: number; target: EffectTarget }
  | { type: 'counter_stack_item'; target: EffectTarget }
  | { type: 'create_token'; playerId?: PlayerId; token: CardDefinition; amount: number }

export interface CardDefinition {
  id: string
  name: string
  types: CardType[]
  typeLine?: string
  manaCost?: string
  manaValue?: number
  oracleText?: string
  keywords?: Keyword[]
  power?: number
  toughness?: number
  producesMana?: Partial<ManaPool>
  effects?: EngineEffect[]
  entersEffects?: EngineEffect[]
  imageUri?: string
}

export interface CardInstance extends CardDefinition {
  instanceId: CardInstanceId
  ownerId: PlayerId
  controllerId: PlayerId
  tapped: boolean
  counters: Record<string, number>
  damageMarked: number
  summoningSick: boolean
  enteredTurn: number
  temporaryPower: number
  temporaryToughness: number
  continuousPower: number
  continuousToughness: number
  attacking: boolean
  blocking: CardInstanceId | null
  token: boolean
}

export interface PlayerZones {
  library: CardInstanceId[]
  hand: CardInstanceId[]
  battlefield: CardInstanceId[]
  graveyard: CardInstanceId[]
  exile: CardInstanceId[]
  command: CardInstanceId[]
}

export interface PlayerState {
  id: PlayerId
  name: string
  life: number
  manaPool: ManaPool
  zones: PlayerZones
  landsPlayedThisTurn: number
  landPlayLimit: number
  cardsDrawn: number
  lost: boolean
}

export interface StackItem {
  id: StackItemId
  kind: 'spell' | 'ability'
  controllerId: PlayerId
  sourceId: CardInstanceId
  cardId?: CardInstanceId
  name: string
  effects: EngineEffect[]
  targets: TargetRef[]
  counterable: boolean
}

export interface CombatState {
  defendingPlayerId: PlayerId | null
  attackers: CardInstanceId[]
  blockers: Record<CardInstanceId, CardInstanceId[]>
  attackersDeclared: boolean
  blockersDeclared: boolean
  firstStrikeDamageDealt: boolean
  damageDealt: boolean
}

export interface GameEvent {
  id: number
  turn: number
  phase: GamePhase
  type: string
  message: string
  playerId?: PlayerId
  cardId?: CardInstanceId
}

export interface GameState {
  players: Record<PlayerId, PlayerState>
  playerOrder: PlayerId[]
  cards: Record<CardInstanceId, CardInstance>
  phase: GamePhase
  turnNumber: number
  activePlayerId: PlayerId
  priorityPlayerId: PlayerId | null
  consecutivePasses: number
  stack: StackItem[]
  combat: CombatState
  winnerId: PlayerId | null
  isDraw: boolean
  started: boolean
  skipFirstDraw: boolean
  eventSequence: number
  stackSequence: number
  events: GameEvent[]
}

export interface GamePlayerSetup {
  id: PlayerId
  name: string
  deck: CardDefinition[]
}

export interface CreateGameOptions {
  players: GamePlayerSetup[]
  startingPlayerId?: PlayerId
  startingLife?: number
  openingHandSize?: number
  skipFirstDraw?: boolean
}

export type GameAction =
  | { type: 'PASS_PRIORITY'; playerId: PlayerId }
  | { type: 'ADVANCE_PHASE'; playerId: PlayerId }
  | { type: 'PLAY_LAND'; playerId: PlayerId; cardId: CardInstanceId }
  | { type: 'TAP_FOR_MANA'; playerId: PlayerId; cardId: CardInstanceId; color?: ManaColor }
  | { type: 'CAST_SPELL'; playerId: PlayerId; cardId: CardInstanceId; targets?: TargetRef[]; xValue?: number }
  | {
      type: 'ACTIVATE_ABILITY'
      playerId: PlayerId
      sourceId: CardInstanceId
      name: string
      effects: EngineEffect[]
      targets?: TargetRef[]
      manaCost?: string
      tapSource?: boolean
      manaAbility?: boolean
    }
  | { type: 'DECLARE_ATTACKERS'; playerId: PlayerId; attackerIds: CardInstanceId[]; defenderId?: PlayerId }
  | { type: 'DECLARE_BLOCKERS'; playerId: PlayerId; assignments: Record<CardInstanceId, CardInstanceId[]> }
  | { type: 'CONCEDE'; playerId: PlayerId }

export interface ActionResult {
  state: GameState
  accepted: boolean
  error?: string
}

export interface LegalityResult {
  legal: boolean
  reason?: string
}

export const EMPTY_MANA_POOL: ManaPool = Object.freeze({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
