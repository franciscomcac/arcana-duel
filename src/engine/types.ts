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
  /** The reverse of 'controlled-creature': a creature controlled by anyone other than the ability's
   * controller. Covers oracle phrasings like "target creature an opponent controls". */
  | 'opponent-creature'
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
  /** Attaches the ability's source (an Equipment/Aura permanent) onto the target permanent, setting the
   * target's instanceId as the source's `attachedToId`. Used by the equip subsystem (see CardInstance). */
  | { type: 'attach'; target: EffectTarget }

/** What an Equipment/Aura-style permanent grants to whatever it's attached to, folded into
 * getPower/getToughness/hasKeyword generically for any card that carries this - not specific to any one
 * named card. */
export interface AttachGrant {
  power?: number
  toughness?: number
  keywords?: string[]
}

/** An equip ability's cost. Equip never taps the source (rule 702.6e) and is sorcery-speed only; both are
 * enforced where the equip action is constructed/validated, not stored here. */
export interface EquipAbility {
  cost: string
}

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
  /** True for permanents whose type line includes "Legendary" (drives the legend rule). */
  legendary?: boolean
  /** Present on Equipment-style permanents: the mana cost of their equip ability. */
  equip?: EquipAbility
  /** What this permanent grants to whatever it's attached to (only meaningful once attached). */
  attachGrant?: AttachGrant
  /**
   * Minimal, Embercleave-shaped piece of the eventual general trigger system (see ROADMAP Phase 4's
   * oracle-pipeline item, which is explicitly out of scope for this pass): when true, this permanent
   * auto-attaches, for free, to a creature its controller declares as an attacker - the mechanism behind
   * "Whenever a creature you control attacks, equip this onto it for free." This is NOT a general
   * "attacks" trigger bucket; it only recognizes this one shape of ability.
   */
  attachOnAttackerDeclared?: boolean
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
  /** The permanent this Equipment/Aura is currently attached to, if any. Cleared automatically whenever
   * the attached permanent leaves the battlefield (see moveCard in game.ts). */
  attachedToId?: CardInstanceId
  /** Keywords granted by an attached Equipment/Aura's attachGrant, recomputed every
   * refreshContinuousEffects pass (mirrors continuousPower/continuousToughness). Checked by hasKeyword()
   * alongside the card's own static `keywords`. */
  grantedKeywords: string[]
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
  /** Set to a player who must discard down to the maximum hand size before the game can proceed. */
  pendingDiscard: PlayerId | null
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
      /** Sacrifices the ability's own source as part of activating it (e.g. "Sacrifice this creature:"). */
      sacrificeSource?: boolean
      /** Number of cards that must be discarded to pay this ability's cost (e.g. "Discard a card:"). */
      discardCount?: number
      /** The specific hand cards chosen to satisfy `discardCount`. Required when discardCount is set. */
      discardCardIds?: CardInstanceId[]
      /** Life paid to activate this ability (e.g. "Pay 3 life:"). */
      payLife?: number
      /** True for abilities (like equip) that can only be activated when a sorcery could be cast. */
      sorcerySpeedOnly?: boolean
    }
  | { type: 'DECLARE_ATTACKERS'; playerId: PlayerId; attackerIds: CardInstanceId[]; defenderId?: PlayerId }
  | { type: 'DECLARE_BLOCKERS'; playerId: PlayerId; assignments: Record<CardInstanceId, CardInstanceId[]> }
  | { type: 'ORDER_BLOCKERS'; playerId: PlayerId; attackerId: CardInstanceId; order: CardInstanceId[] }
  | { type: 'DISCARD_CARDS'; playerId: PlayerId; cardIds: CardInstanceId[] }
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

/** Standard Magic maximum hand size, enforced at cleanup. No format override exists yet. */
export const MAX_HAND_SIZE = 7
