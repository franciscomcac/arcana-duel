import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import {
  Archive,
  ArrowDownWideNarrow,
  ChevronRight,
  CircleOff,
  Clock3,
  Eye,
  Flame,
  Hand,
  History,
  Layers3,
  Leaf,
  Menu,
  MessageCircle,
  Settings,
  Shield,
  Sparkles,
  Swords,
  Volume2,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CardZoom } from '../CardZoom'
import { botDeck, catalog, type CatalogCard, type SavedDeck } from '../catalog'
import {
  canBlockAttacker,
  checkAction,
  chooseBotAction,
  gameReducer,
  getManaProduction,
  getPhaseLabel,
  MAX_HAND_SIZE,
  type CardInstanceId,
  type GameAction,
  type GameState,
  type PlayerId,
  type TargetRef,
  type ZoneName,
} from '../engine'
import type { CardData } from '../types'
import { GameAudio, soundForGameEvent } from '../services/gameAudio'
import {
  arenaPhase,
  BOT_PLAYER_ID,
  bottomOpeningCards,
  castTargetCount,
  castWithAutomaticMana,
  createPracticeGame,
  engineCardToView,
  eventsToLog,
  findManaActions,
  HUMAN_PLAYER_ID,
  legalAttackers,
  legalTargets,
  requiredTargetCount,
  takeLondonMulligan,
  zoneCards,
} from './arenaAdapter'
import { HAND_SORT_OPTIONS, isHandSortMode, sortHand, type HandSortMode } from './handSorting'

const HAND_SORT_STORAGE_KEY = 'arcana.practice.hand-sort'

const AUTO_SKIP_PASS_PHASES = new Set([
  'untap',
  'upkeep',
  'draw',
  'begin_combat',
  'combat_damage',
  'end_combat',
  'end',
  'cleanup',
])

type BrowseZone = Extract<ZoneName, 'graveyard' | 'exile'>
type OpenZone = { playerId: PlayerId; zone: BrowseZone } | null

interface CardProps {
  card: CardData
  zone: 'hand' | 'field' | 'preview' | 'stack'
  selected?: boolean
  eligible?: boolean
  manaReady?: boolean
  disabled?: boolean
  onClick?: () => void
  onHover?: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onDoubleClick?: () => void
  index?: number
  combatDirection?: -1 | 1
  combatImpact?: boolean
}

type IntentEndpoint = { kind: 'card' | 'player'; id: string }
type IntentLink = { from: IntentEndpoint; to: IntentEndpoint; tone: 'attack' | 'block' | 'target'; preview?: boolean }

function IntentLines({ links }: { links: IntentLink[] }) {
  const [paths, setPaths] = useState<Array<IntentLink & { x1: number; y1: number; x2: number; y2: number }>>([])

  useLayoutEffect(() => {
    const position = () => {
      const shell = document.querySelector('.game-shell')?.getBoundingClientRect()
      if (!shell) return
      const locate = (endpoint: IntentEndpoint) => [...document.querySelectorAll<HTMLElement>(`[data-${endpoint.kind}-id="${CSS.escape(endpoint.id)}"]`)]
        .map((node) => node.getBoundingClientRect())
        .find((rect) => rect.width > 0 && rect.height > 0)
      setPaths(links.flatMap((link) => {
        const from = locate(link.from)
        const to = locate(link.to)
        if (!from || !to) return []
        return [{ ...link, x1: from.left + from.width / 2 - shell.left, y1: from.top + from.height / 2 - shell.top, x2: to.left + to.width / 2 - shell.left, y2: to.top + to.height / 2 - shell.top }]
      }))
    }
    const observer = new ResizeObserver(position)
    const shell = document.querySelector('.game-shell')
    if (shell) observer.observe(shell)
    window.addEventListener('resize', position)
    position()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [links])

  if (!paths.length) return null
  return <svg className="intent-lines" aria-hidden="true">{paths.map((path, index) => <g key={`${path.tone}-${path.from.id}-${path.to.id}-${index}`} className={`${path.tone} ${path.preview ? 'preview' : ''}`}><line x1={path.x1} y1={path.y1} x2={path.x2} y2={path.y2} /><circle cx={path.x2} cy={path.y2} r="7" /></g>)}</svg>
}

function manaIcon(card: CardData) {
  if (card.color === 'red') return <Flame size={14} strokeWidth={2.5} />
  if (card.color === 'green') return <Leaf size={14} strokeWidth={2.5} />
  if (card.color === 'gold') return <><Flame size={10} strokeWidth={2.5} /><Leaf size={10} strokeWidth={2.5} /></>
  return <span>{card.cost}</span>
}

function GameCard({ card, zone, selected, eligible, manaReady, disabled, onClick, onHover, onDragStart, onDragEnd, onDoubleClick, index = 0, combatDirection = -1, combatImpact = false }: CardProps) {
  const reduceMotion = useReducedMotion()
  const [imageFailed, setImageFailed] = useState(false)
  const stats = card.power !== undefined ? `${card.power + (card.buff ?? 0)}/${card.toughness! + (card.buff ?? 0)}` : null
  const visuallyTapped = zone === 'field' && card.tapped
  const visuallyAttacking = zone === 'field' && card.attacking
  const restingY = zone === 'hand' && selected ? -82 : visuallyAttacking ? combatDirection * 14 : 0

  useEffect(() => setImageFailed(false), [card.image])

  return (
    <motion.button
      type="button"
      data-card-id={card.uid}
      layout={zone === 'preview' || zone === 'stack' ? false : 'position'}
      layoutId={zone === 'preview' || zone === 'stack' ? undefined : `arena-card-${card.uid}`}
      draggable={zone === 'hand' && !disabled}
      aria-disabled={disabled || undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onHover}
      aria-label={`${card.name}${visuallyTapped ? ', tapped' : ''}${manaReady ? ', tap for mana' : ''}${disabled ? ', cannot be played right now' : ''}`}
      className={`game-card ${zone} ${selected ? 'selected' : ''} ${eligible ? 'eligible' : ''} ${manaReady ? 'mana-ready' : ''} ${disabled ? 'disabled' : ''} ${visuallyTapped ? 'tapped' : ''} ${visuallyAttacking ? 'attacking' : ''}`}
      initial={reduceMotion ? false : zone === 'hand' ? { y: 54, opacity: 0, scale: 0.92 } : { scale: 0.84, opacity: 0 }}
      animate={combatImpact && !reduceMotion
        ? { y: [restingY, combatDirection * 38, combatDirection * 31, restingY], x: [0, index % 2 ? 5 : -5, 0, 0], scale: [1, 1.08, 1.035, 1], opacity: 1, rotate: [visuallyTapped ? 90 : 0, combatDirection * (index % 2 ? -3 : 3), visuallyTapped ? 90 : 0] }
        : { y: reduceMotion ? 0 : restingY, x: 0, scale: 1, opacity: 1, rotate: visuallyTapped ? 90 : 0 }}
      exit={reduceMotion ? { opacity: 0 } : zone === 'hand' ? { y: -145, opacity: 0, scale: 0.82 } : { opacity: 0, scale: 0.72 }}
      transition={reduceMotion ? { duration: 0 } : combatImpact
        ? { duration: .48, times: [0, .42, .58, 1], ease: ['easeIn', 'easeOut', 'easeOut'] }
        : { type: 'spring', stiffness: 410, damping: 32, mass: 0.78, delay: Math.min(index * 0.028, 0.14) }}
      whileHover={reduceMotion ? undefined : zone === 'hand' ? { y: disabled ? -88 : -104, scale: disabled ? 1.025 : 1.055, zIndex: 40 } : { scale: 1.045, zIndex: 20 }}
      whileFocus={reduceMotion ? undefined : zone === 'hand' ? { y: disabled ? -88 : -104, scale: disabled ? 1.025 : 1.055, zIndex: 40 } : { scale: 1.045, zIndex: 20 }}
      whileTap={{ scale: 0.97 }}
    >
      <span className={`card-art card-art-${card.color}`}>
        {!imageFailed && <img src={card.image} alt="" draggable={false} decoding="async" onError={() => setImageFailed(true)} />}
        {imageFailed && <span className="card-art-fallback" aria-hidden="true"><Sparkles size={18} /><b>{card.name}</b><small>{card.typeLine}</small></span>}
        <span className="card-edge" aria-hidden="true" />
        <span className="card-glint" aria-hidden="true" />
      </span>
      {zone !== 'preview' && zone !== 'field' && <span className={`mana-badge ${card.color}`}>{manaIcon(card)}</span>}
      {stats && zone === 'field' && <span className="stat-badge">{stats}</span>}
      {card.summoningSick && zone === 'field' && <span className="sick-badge" title="Summoning sickness"><Clock3 size={11} /></span>}
      {zone === 'field' && card.buff && <span className="buff-badge">{card.buff > 0 ? '+' : ''}{card.buff}</span>}
      {visuallyAttacking && <span className="attack-marker"><Swords size={14} /></span>}
      {combatImpact && <span className="combat-flash" aria-hidden="true" />}
    </motion.button>
  )
}

function organizeLandPiles(cards: CardData[]): CardData[][] {
  const ordered = [...cards].sort((left, right) => {
    if (left.tapped !== right.tapped) return Number(left.tapped) - Number(right.tapped)
    return left.oracleName.localeCompare(right.oracleName) || left.uid.localeCompare(right.uid)
  })

  return ordered.reduce<CardData[][]>((piles, card) => {
    const current = piles.at(-1)
    const first = current?.[0]
    if (first && first.oracleName === card.oracleName && first.tapped === card.tapped) current.push(card)
    else piles.push([card])
    return piles
  }, [])
}

function PlayerBadge({ opponent = false, life, active, targetable, onTarget, onHover }: { opponent?: boolean; life: number; active: boolean; targetable?: boolean; onTarget?: () => void; onHover?: () => void }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.button
      type="button"
      data-player-id={opponent ? BOT_PLAYER_ID : HUMAN_PLAYER_ID}
      onClick={onTarget}
      onMouseEnter={onHover}
      disabled={!targetable}
      className={`player-badge ${opponent ? 'opponent' : 'self'} ${active ? 'active' : ''} ${targetable ? 'targetable' : ''}`}
      animate={!reduceMotion && targetable ? { scale: [1, 1.025, 1] } : { scale: 1 }}
      transition={{ repeat: !reduceMotion && targetable ? Infinity : 0, duration: 1.3 }}
    >
      <span className="portrait-shell">
        <span className="portrait"><img src={opponent ? '/cards/kessig-naturalist.jpg' : '/cards/questing-beast.jpg'} alt="" /></span>
        <span className="level">{opponent ? '32' : '28'}</span>
      </span>
      <span className="identity">
        <b>{opponent ? 'VEX_MAGE' : 'YOU'}</b>
        <small>{active ? 'Priority' : 'Waiting'}</small>
      </span>
      <span className="life-total">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={life}
            initial={reduceMotion ? false : { opacity: 0, y: life < 20 ? -10 : 10, scale: 1.35 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.72 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: 'easeOut' }}
          >{life}</motion.span>
        </AnimatePresence>
      </span>
    </motion.button>
  )
}

function initialHandSort(): HandSortMode {
  try {
    const stored = window.localStorage.getItem(HAND_SORT_STORAGE_KEY)
    return isHandSortMode(stored) ? stored : 'mana'
  } catch {
    return 'mana'
  }
}

function fallbackCard(): CardData {
  const card = catalog[0]
  return {
    uid: card.id,
    oracleName: card.name,
    name: card.name,
    kind: card.kind,
    color: card.color,
    cost: card.cost,
    mana: card.mana,
    typeLine: card.typeLine,
    rules: card.rules,
    power: card.power,
    toughness: card.toughness,
    image: card.image,
  }
}

function targetEquals(left: TargetRef, right: TargetRef): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'player' && right.kind === 'player') return left.playerId === right.playerId
  if (left.kind === 'permanent' && right.kind === 'permanent') return left.cardId === right.cardId
  if (left.kind === 'stack' && right.kind === 'stack') return left.stackItemId === right.stackItemId
  return false
}

function canBotAct(state: GameState): boolean {
  if (state.winnerId || state.isDraw) return false
  if (state.phase === 'declare_attackers' && state.activePlayerId === BOT_PLAYER_ID && !state.combat.attackersDeclared) return true
  if (state.phase === 'declare_blockers' && state.combat.defendingPlayerId === BOT_PLAYER_ID && !state.combat.blockersDeclared) return true
  return state.priorityPlayerId === BOT_PLAYER_ID
}

export function PracticeMatch({ onExit, deck }: { onExit: () => void; deck: SavedDeck }) {
  const makeGame = useCallback(() => createPracticeGame(deck, botDeck()), [deck])
  const [game, setGame] = useState(makeGame)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectedId, setInspectedId] = useState<string | null>(() => game.players[HUMAN_PLAYER_ID].zones.hand[0] ?? null)
  const [targetingId, setTargetingId] = useState<string | null>(null)
  const [chosenTargets, setChosenTargets] = useState<TargetRef[]>([])
  const [attackerSelection, setAttackerSelection] = useState<Set<CardInstanceId>>(new Set())
  const [blockingAttackerId, setBlockingAttackerId] = useState<string | null>(null)
  const [blockAssignments, setBlockAssignments] = useState<Record<string, string[]>>({})
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [toast, setToast] = useState('Review your opening hand')
  const [showLog, setShowLog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const [autoPass, setAutoPass] = useState(true)
  const [timer, setTimer] = useState(0)
  const [damagePulse, setDamagePulse] = useState<'self' | 'opponent' | null>(null)
  const [zoomed, setZoomed] = useState<CardData | null>(null)
  const [pregame, setPregame] = useState<'review' | 'bottom' | 'done'>('review')
  const [mulliganCount, setMulliganCount] = useState(0)
  const [bottomSelection, setBottomSelection] = useState<Set<string>>(new Set())
  const [botThinking, setBotThinking] = useState(false)
  const [handSort, setHandSort] = useState<HandSortMode>(initialHandSort)
  const [openZone, setOpenZone] = useState<OpenZone>(null)
  const [discardSelection, setDiscardSelection] = useState<Set<string>>(new Set())
  const [orderingAttackerId, setOrderingAttackerId] = useState<string | null>(null)
  const [damageOrderSelection, setDamageOrderSelection] = useState<CardInstanceId[]>([])
  const [orderedAttackerIds, setOrderedAttackerIds] = useState<Set<string>>(new Set())
  const previousLife = useRef({ human: 20, bot: 20 })
  const audio = useRef(new GameAudio())
  const lastSoundEvent = useRef(game.eventSequence)
  const hoverPauseUntilRef = useRef(0)
  const [announcements, setAnnouncements] = useState<Array<{ id: number; card: CardData }>>([])
  const previousStackIds = useRef(new Set<string>())
  const announcementIdRef = useRef(0)

  const hand = useMemo(() => zoneCards(game, HUMAN_PLAYER_ID, 'hand'), [game])
  const sortedHand = useMemo(() => sortHand(hand, handSort), [hand, handSort])
  const playerBoard = useMemo(() => zoneCards(game, HUMAN_PLAYER_ID, 'battlefield'), [game])
  const opponentBoard = useMemo(() => zoneCards(game, BOT_PLAYER_ID, 'battlefield'), [game])
  const libraryCount = game.players[HUMAN_PLAYER_ID].zones.library.length
  const opponentHandCount = game.players[BOT_PLAYER_ID].zones.hand.length
  const opponentLibraryCount = game.players[BOT_PLAYER_ID].zones.library.length
  const playerLife = game.players[HUMAN_PLAYER_ID].life
  const opponentLife = game.players[BOT_PLAYER_ID].life
  const selected = selectedId ? game.cards[selectedId] : null
  const targeting = targetingId ? game.cards[targetingId] : null
  const inspectedInstance = inspectedId ? game.cards[inspectedId] : null
  const inspected = inspectedInstance ? engineCardToView(inspectedInstance) : hand[0] ?? fallbackCard()
  const lands = playerBoard.filter((card) => card.kind === 'land')
  const creatures = playerBoard.filter((card) => card.kind === 'creature')
  const otherPermanents = playerBoard.filter((card) => card.kind !== 'land' && card.kind !== 'creature')
  const opponentLands = opponentBoard.filter((card) => card.kind === 'land')
  const opponentCreatures = opponentBoard.filter((card) => card.kind === 'creature')
  const opponentOtherPermanents = opponentBoard.filter((card) => card.kind !== 'land' && card.kind !== 'creature')
  const playerLandPiles = useMemo(() => organizeLandPiles(lands), [lands])
  const opponentLandPiles = useMemo(() => organizeLandPiles(opponentLands), [opponentLands])
  const legalAttackerIds = useMemo(() => new Set(legalAttackers(game, HUMAN_PLAYER_ID)), [game])
  const targetOptions = useMemo(() => targetingId ? legalTargets(game, HUMAN_PLAYER_ID, targetingId, chosenTargets) : [], [chosenTargets, game, targetingId])
  const manaInPool = Object.values(game.players[HUMAN_PLAYER_ID].manaPool).reduce((sum, amount) => sum + amount, 0)
  const log = useMemo(() => eventsToLog(game), [game])
  const playerHasPriority = game.priorityPlayerId === HUMAN_PLAYER_ID
  const playerTurn = game.activePlayerId === HUMAN_PLAYER_ID
  const legacyPhase = arenaPhase(game.phase)
  const topStackItem = game.stack.at(-1)
  const stackCard = topStackItem ? engineCardToView(game.cards[topStackItem.sourceId]) : null
  const draggingCard = draggingId ? game.cards[draggingId] : null
  const openZoneCards = openZone ? zoneCards(game, openZone.playerId, openZone.zone) : []
  const opponentAttackers = game.combat.attackers.map((cardId) => game.cards[cardId]).filter((card): card is NonNullable<typeof card> => !!card)
  const combatBlockerIds = useMemo(() => new Set(Object.values(game.combat.blockers).flat()), [game.combat.blockers])
  const combatAnimating = game.combat.blockersDeclared && !game.combat.damageDealt
  const availableBlockers = creatures.filter((card) => !card.tapped && !card.summoningSick)
  const canDeclareAnyBlocker = opponentAttackers.length > 0 && availableBlockers.length > 0
  const pendingDiscardCount = game.pendingDiscard === HUMAN_PLAYER_ID ? Math.max(0, game.players[HUMAN_PLAYER_ID].zones.hand.length - MAX_HAND_SIZE) : 0
  const orderingBlockerIds = orderingAttackerId ? (game.combat.blockers[orderingAttackerId] ?? []) : []

  const handCardAvailability = useCallback((cardId: string): { playable: boolean; reason: string } => {
    const card = game.cards[cardId]
    if (!card || !game.players[HUMAN_PLAYER_ID].zones.hand.includes(cardId)) return { playable: false, reason: 'Not in your hand' }
    if (game.winnerId || game.isDraw) return { playable: false, reason: 'The match is over' }
    if (!playerHasPriority) return { playable: false, reason: 'Waiting for priority' }
    if (card.types.includes('land')) {
      const legality = checkAction(game, { type: 'PLAY_LAND', playerId: HUMAN_PLAYER_ID, cardId })
      return { playable: legality.legal, reason: legality.legal ? 'Ready to play' : legality.reason ?? 'Cannot play this land now' }
    }
    const instantTiming = card.types.includes('instant') || (card.keywords ?? []).includes('flash')
    if (!instantTiming && (!playerTurn || !['main1', 'main2'].includes(game.phase) || game.stack.length > 0)) {
      return { playable: false, reason: 'Requires your main phase and an empty stack' }
    }
    if (findManaActions(game, HUMAN_PLAYER_ID, card.manaCost) === null) return { playable: false, reason: 'Not enough ready mana' }
    return { playable: true, reason: instantTiming ? 'Ready at instant speed' : 'Ready to cast' }
  }, [game, playerHasPriority, playerTurn])

  const readyMana = useMemo(() => {
    const colors = new Set<string>()
    let sources = 0
    for (const cardId of game.players[HUMAN_PLAYER_ID].zones.battlefield) {
      const card = game.cards[cardId]
      if (!card || card.tapped) continue
      if (card.types.includes('creature') && card.summoningSick && !(card.keywords ?? []).includes('haste')) continue
      const production = getManaProduction(card)
      const availableColors = Object.entries(production).filter(([, amount]) => (amount ?? 0) > 0).map(([color]) => color)
      if (!availableColors.length) continue
      sources += 1
      availableColors.forEach((color) => colors.add(color))
    }
    return { sources, colors }
  }, [game])

  const inspectedHandStatus = inspectedId && game.players[HUMAN_PLAYER_ID].zones.hand.includes(inspectedId)
    ? handCardAvailability(inspectedId)
    : null

  const dragDestination = draggingCard
    ? draggingCard.types.includes('land')
      ? 'dragging-land'
      : draggingCard.types.includes('creature')
        ? 'dragging-creature'
        : draggingCard.types.some((type) => ['artifact', 'enchantment', 'planeswalker', 'battle'].includes(type))
          ? 'dragging-permanent'
          : 'dragging-spell'
    : ''

  const boardPrompt = (() => {
    if (game.winnerId) return { title: game.winnerId === HUMAN_PLAYER_ID ? 'Victory' : 'Defeat', detail: 'Match complete' }
    if (game.isDraw) return { title: 'Draw game', detail: 'Match complete' }
    if (targeting) return { title: 'Choose target', detail: `${targeting.name} - ${chosenTargets.length + 1} of ${requiredTargetCount(targeting)}` }
    if (selected) return { title: `${selected.name} selected`, detail: selected.types.includes('land') ? 'Land play ready' : `Cast for ${selected.manaCost ?? selected.manaValue ?? 0}` }
    if (game.phase === 'declare_attackers' && playerTurn && !game.combat.attackersDeclared) return { title: 'Declare attackers', detail: `${attackerSelection.size} selected` }
    if (game.phase === 'declare_blockers' && game.combat.defendingPlayerId === HUMAN_PLAYER_ID && !game.combat.blockersDeclared) {
      const attackerName = blockingAttackerId ? game.cards[blockingAttackerId]?.name : null
      return { title: 'Declare blockers', detail: attackerName ? `Assigning to ${attackerName}` : 'Choose an attacker' }
    }
    if (topStackItem) return { title: `${topStackItem.name} on stack`, detail: playerHasPriority ? 'Your response window' : 'Opponent response window' }
    if (!playerHasPriority) return { title: 'Opponent has priority', detail: getPhaseLabel(game.phase) }
    return { title: playerTurn ? `Your ${getPhaseLabel(game.phase)}` : `Opponent ${getPhaseLabel(game.phase)}`, detail: 'You have priority' }
  })()

  const pauseAutoFlow = useCallback(() => {
    hoverPauseUntilRef.current = Date.now() + 5000
  }, [])

  const dispatch = useCallback((action: GameAction): boolean => {
    const result = gameReducer(game, action)
    if (!result.accepted) {
      setToast(result.error ?? 'That action is not legal right now.')
      return false
    }
    setGame(result.state)
    return true
  }, [game])

  useEffect(() => {
    if (pregame !== 'done') return
    const interval = window.setInterval(() => setTimer((value) => value + 1), 1000)
    return () => window.clearInterval(interval)
  }, [pregame])

  useEffect(() => {
    try {
      window.localStorage.setItem(HAND_SORT_STORAGE_KEY, handSort)
    } catch {
      // The preference remains active for this match when storage is unavailable.
    }
  }, [handSort])

  useEffect(() => {
    audio.current.setEnabled(soundOn)
    const unlock = () => void audio.current.unlock()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [soundOn])

  useEffect(() => {
    if (game.eventSequence === lastSoundEvent.current) return
    const freshEvents = game.events.filter((event) => event.id > lastSoundEvent.current)
    lastSoundEvent.current = game.eventSequence
    if (!soundOn) return
    freshEvents.forEach((event, index) => {
      const sound = soundForGameEvent(event.type)
      if (sound) window.setTimeout(() => audio.current.play(sound), index * 55)
    })
  }, [game.eventSequence, game.events, soundOn])

  // Announce newly cast spells (stack pushes) with a prominent, temporary overlay so
  // fast casts are actually visible. Purely presentational - never delays game logic.
  useEffect(() => {
    const currentIds = new Set(game.stack.map((item) => item.id))
    const previousIds = previousStackIds.current
    const newItems = game.stack.filter((item) => !previousIds.has(item.id))
    previousStackIds.current = currentIds
    if (!newItems.length) return
    setAnnouncements((queue) => [
      ...queue,
      ...newItems.map((item) => ({ id: announcementIdRef.current++, card: engineCardToView(game.cards[item.sourceId]) })),
    ])
  }, [game.stack])

  const activeAnnouncement = announcements[0] ?? null

  useEffect(() => {
    if (!activeAnnouncement) return
    const timeout = window.setTimeout(() => {
      setAnnouncements((queue) => queue.slice(1))
    }, 3000)
    return () => window.clearTimeout(timeout)
  }, [activeAnnouncement])

  useEffect(() => {
    if (selectedId && !handCardAvailability(selectedId).playable) setSelectedId(null)
  }, [handCardAvailability, selectedId])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (playerLife < previousLife.current.human) {
      setDamagePulse('self')
      window.setTimeout(() => setDamagePulse(null), 520)
    } else if (opponentLife < previousLife.current.bot) {
      setDamagePulse('opponent')
      window.setTimeout(() => setDamagePulse(null), 520)
    }
    previousLife.current = { human: playerLife, bot: opponentLife }
  }, [opponentLife, playerLife])

  useEffect(() => {
    setAttackerSelection((current) => game.phase === 'declare_attackers' && !game.combat.attackersDeclared ? current : new Set())
    if (game.phase !== 'declare_blockers' || game.combat.blockersDeclared) {
      setBlockingAttackerId(null)
      setBlockAssignments({})
    }
  }, [game.combat.attackersDeclared, game.combat.blockersDeclared, game.phase])

  useEffect(() => {
    if (pregame !== 'done' || !canBotAct(game)) return
    const decision = chooseBotAction(game, BOT_PLAYER_ID)
    if (!decision) return
    setBotThinking(true)
    const timeout = window.setTimeout(() => {
      const result = gameReducer(game, decision.action)
      setBotThinking(false)
      if (result.accepted) {
        setGame(result.state)
        setToast(decision.reason)
      } else {
        setToast(result.error ?? 'The practice bot could not complete its action.')
      }
    }, 420)
    return () => {
      window.clearTimeout(timeout)
      setBotThinking(false)
    }
  }, [game, pregame])

  // A meaningful reason for auto-pass to stop and hand control back to the player:
  // merely holding a castable instant is NOT one (see hasInstantResponse's old usage) -
  // only an actual response opportunity (something on the stack) or a live combat-trick
  // window counts.
  // something is actually on the stack to respond to, or we're in a live combat-trick window.
  const shouldPauseForDecision = game.stack.length > 0
    || game.phase === 'declare_attackers'
    || game.phase === 'declare_blockers'
    || game.phase === 'combat_damage'

  const scheduleAutoAction = useCallback((run: () => void, delay: number): (() => void) => {
    let cancelled = false
    let timeoutId = 0
    const fire = () => {
      if (cancelled) return
      const remaining = hoverPauseUntilRef.current - Date.now()
      if (remaining > 0) {
        timeoutId = window.setTimeout(fire, remaining)
        return
      }
      run()
    }
    timeoutId = window.setTimeout(fire, delay)
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [])

  useEffect(() => {
    const mustBlock = game.phase === 'declare_blockers'
      && game.combat.defendingPlayerId === HUMAN_PLAYER_ID
      && !game.combat.blockersDeclared
    if (!autoPass || pregame !== 'done' || playerTurn || !playerHasPriority || shouldPauseForDecision || mustBlock || targetingId || pendingDiscardCount > 0 || orderingAttackerId) return
    return scheduleAutoAction(() => {
      const result = gameReducer(game, { type: 'PASS_PRIORITY', playerId: HUMAN_PLAYER_ID })
      if (result.accepted) setGame(result.state)
    }, 520)
  }, [autoPass, game, orderingAttackerId, pendingDiscardCount, playerHasPriority, playerTurn, pregame, scheduleAutoAction, shouldPauseForDecision, targetingId])

  // Move through mandatory steps when the player has no meaningful decision.
  useEffect(() => {
    if (!autoPass || pregame !== 'done' || botThinking || targetingId || !playerTurn || !playerHasPriority || pendingDiscardCount > 0 || orderingAttackerId) return
    if (shouldPauseForDecision || !AUTO_SKIP_PASS_PHASES.has(game.phase)) return
    return scheduleAutoAction(() => {
      const result = gameReducer(game, { type: 'PASS_PRIORITY', playerId: HUMAN_PLAYER_ID })
      if (result.accepted) setGame(result.state)
    }, 360)
  }, [autoPass, botThinking, game, orderingAttackerId, pendingDiscardCount, playerHasPriority, playerTurn, pregame, scheduleAutoAction, shouldPauseForDecision, targetingId])

  // Skip combat decisions that cannot produce a different game state.
  useEffect(() => {
    if (!autoPass || pregame !== 'done' || botThinking || targetingId || pendingDiscardCount > 0 || orderingAttackerId) return
    if (game.phase === 'declare_attackers' && playerTurn && !game.combat.attackersDeclared && legalAttackerIds.size === 0) {
      return scheduleAutoAction(() => {
        const result = gameReducer(game, { type: 'DECLARE_ATTACKERS', playerId: HUMAN_PLAYER_ID, attackerIds: [] })
        if (result.accepted) setGame(result.state)
      }, 320)
    }
    if (game.phase === 'declare_blockers' && game.combat.defendingPlayerId === HUMAN_PLAYER_ID && !game.combat.blockersDeclared && !canDeclareAnyBlocker) {
      return scheduleAutoAction(() => {
        const result = gameReducer(game, { type: 'DECLARE_BLOCKERS', playerId: HUMAN_PLAYER_ID, assignments: {} })
        if (result.accepted) setGame(result.state)
      }, 320)
    }
    return undefined
  }, [autoPass, botThinking, canDeclareAnyBlocker, game, legalAttackerIds.size, orderingAttackerId, pendingDiscardCount, playerTurn, pregame, scheduleAutoAction, targetingId])

  useEffect(() => {
    const latest = game.events.at(-1)
    if (latest && pregame === 'done') setToast(latest.message)
  }, [game.eventSequence, game.events, pregame])

  // Reset once-per-combat damage-order bookkeeping when a new turn begins.
  useEffect(() => {
    setOrderedAttackerIds(new Set())
  }, [game.turnNumber])

  // When the human attacks and a double-blocked attacker's blocks are declared, prompt for damage order.
  useEffect(() => {
    const canOrderNow = pregame === 'done'
      && game.phase === 'declare_blockers'
      && game.combat.blockersDeclared
      && !game.combat.damageDealt
      && playerHasPriority
      && playerTurn
    if (!canOrderNow) {
      if (orderingAttackerId) { setOrderingAttackerId(null); setDamageOrderSelection([]) }
      return
    }
    if (orderingAttackerId) return
    const next = game.combat.attackers.find((id) => {
      const attacker = game.cards[id]
      return attacker?.controllerId === HUMAN_PLAYER_ID && (game.combat.blockers[id]?.length ?? 0) >= 2 && !orderedAttackerIds.has(id)
    })
    if (next) {
      setOrderingAttackerId(next)
      setDamageOrderSelection([])
      setToast(`${game.cards[next].name} is blocked by multiple creatures - click them in the order to assign damage.`)
    }
  }, [game, orderedAttackerIds, orderingAttackerId, playerHasPriority, playerTurn, pregame])

  // Once every declared blocker for that attacker has been ordered, submit it and move on.
  useEffect(() => {
    if (!orderingAttackerId) return
    const blockers = game.combat.blockers[orderingAttackerId] ?? []
    if (blockers.length > 0 && damageOrderSelection.length >= blockers.length) {
      const result = gameReducer(game, { type: 'ORDER_BLOCKERS', playerId: HUMAN_PLAYER_ID, attackerId: orderingAttackerId, order: damageOrderSelection })
      if (result.accepted) setGame(result.state)
      setOrderedAttackerIds((current) => new Set([...current, orderingAttackerId]))
      setOrderingAttackerId(null)
      setDamageOrderSelection([])
    }
  }, [damageOrderSelection, game, orderingAttackerId])

  const formattedTime = `${String(Math.floor(timer / 60)).padStart(2, '0')}:${String(timer % 60).padStart(2, '0')}`
  const zoomCard = zoomed ? (catalog.find((card) => card.name === zoomed.name) || {
    id: zoomed.uid,
    name: zoomed.name,
    image: zoomed.image,
    color: zoomed.color,
    kind: zoomed.kind as CatalogCard['kind'],
    cost: zoomed.cost,
    mana: zoomed.mana || `${zoomed.cost}`,
    typeLine: zoomed.typeLine,
    rules: zoomed.rules,
    rarity: 'Common' as const,
    power: zoomed.power,
    toughness: zoomed.toughness,
  }) : null

  const takeMulligan = () => {
    const next = takeLondonMulligan(game, HUMAN_PLAYER_ID)
    setGame(next)
    setInspectedId(next.players[HUMAN_PLAYER_ID].zones.hand[0] ?? null)
    setMulliganCount((count) => Math.min(6, count + 1))
    setBottomSelection(new Set())
    setToast('You drew a fresh seven. Each mulligan adds one card to bottom.')
  }

  const keepOpeningHand = () => {
    if (mulliganCount > 0) {
      setPregame('bottom')
      setToast(`Choose ${mulliganCount} card${mulliganCount === 1 ? '' : 's'} to put on the bottom`)
      return
    }
    setPregame('done')
    setToast('Turn 1 - untap step')
  }

  const toggleBottomCard = (cardId: string) => {
    setBottomSelection((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else if (next.size < mulliganCount) next.add(cardId)
      return next
    })
  }

  const confirmBottom = () => {
    const result = bottomOpeningCards(game, HUMAN_PLAYER_ID, [...bottomSelection], mulliganCount)
    if (!result.accepted) {
      setToast(result.error ?? 'Choose the required cards.')
      return
    }
    setGame(result.state)
    setBottomSelection(new Set())
    setPregame('done')
    setToast('Turn 1 - untap step')
  }

  const completeCast = (cardId: string, targets: TargetRef[] = []) => {
    const result = castWithAutomaticMana(game, HUMAN_PLAYER_ID, cardId, targets)
    if (!result.accepted) {
      setToast(result.error ?? 'That spell cannot be cast.')
      return
    }
    setGame(result.state)
    setSelectedId(null)
    setTargetingId(null)
    setChosenTargets([])
  }

  const beginCast = (cardId: string) => {
    const card = game.cards[cardId]
    if (!card) return
    if (card.types.includes('land')) {
      if (dispatch({ type: 'PLAY_LAND', playerId: HUMAN_PLAYER_ID, cardId })) setSelectedId(null)
      return
    }
    // Only enter target-picking mode for slots that must actually be supplied right now. An
    // enters-the-battlefield trigger with no legal target on the board simply fizzles (it never blocks
    // casting the permanent), so it never puts the player into a "choose a legal target" dead end.
    if (castTargetCount(game, HUMAN_PLAYER_ID, card) > 0) {
      if (findManaActions(game, HUMAN_PLAYER_ID, card.manaCost) === null) {
        setToast(`You cannot produce the mana required for ${card.name}.`)
        return
      }
      setTargetingId(cardId)
      setChosenTargets([])
      setToast(`${card.name}: choose a legal target`)
      return
    }
    completeCast(cardId)
  }

  const chooseTarget = (target: TargetRef) => {
    if (!targetingId || !targetOptions.some((option) => targetEquals(option, target))) return
    const nextTargets = [...chosenTargets, target]
    if (nextTargets.length >= castTargetCount(game, HUMAN_PLAYER_ID, game.cards[targetingId])) completeCast(targetingId, nextTargets)
    else setChosenTargets(nextTargets)
  }

  const handleFieldCard = (card: CardData, owner: 'self' | 'opponent') => {
    setInspectedId(card.uid)
    if (orderingAttackerId) {
      if (owner === 'opponent' && orderingBlockerIds.includes(card.uid) && !damageOrderSelection.includes(card.uid)) {
        setDamageOrderSelection((current) => [...current, card.uid])
      }
      return
    }
    if (targetingId) {
      chooseTarget({ kind: 'permanent', cardId: card.uid })
      return
    }
    if (game.phase === 'declare_attackers' && playerTurn && !game.combat.attackersDeclared && owner === 'self' && legalAttackerIds.has(card.uid)) {
      setAttackerSelection((current) => {
        const next = new Set(current)
        if (next.has(card.uid)) next.delete(card.uid)
        else next.add(card.uid)
        return next
      })
      return
    }
    const humanMustBlock = game.phase === 'declare_blockers'
      && game.combat.defendingPlayerId === HUMAN_PLAYER_ID
      && !game.combat.blockersDeclared
    if (humanMustBlock) {
      if (owner === 'opponent' && game.combat.attackers.includes(card.uid)) {
        setBlockingAttackerId(card.uid)
        setToast(`Choose blockers for ${card.name}`)
        return
      }
      if (owner === 'self' && blockingAttackerId && card.kind === 'creature' && !card.tapped) {
        const attackerInstance = game.cards[blockingAttackerId]
        const blockerInstance = game.cards[card.uid]
        if (!attackerInstance || !blockerInstance || !canBlockAttacker(attackerInstance, blockerInstance)) {
          setToast(`${card.name} cannot block ${attackerInstance?.name ?? 'that attacker'}.`)
          return
        }
        setBlockAssignments((current) => {
          const cleaned = Object.fromEntries(Object.entries(current).map(([attackerId, blockers]) => [attackerId, blockers.filter((id) => id !== card.uid)]))
          const alreadyOnSelected = current[blockingAttackerId]?.includes(card.uid)
          if (!alreadyOnSelected) cleaned[blockingAttackerId] = [...(cleaned[blockingAttackerId] ?? []), card.uid]
          return cleaned
        })
      }
      return
    }

    if (owner === 'self') {
      const manaAction: GameAction = { type: 'TAP_FOR_MANA', playerId: HUMAN_PLAYER_ID, cardId: card.uid }
      if (checkAction(game, manaAction).legal && dispatch(manaAction)) setToast(`${card.name} tapped for mana`)
    }
  }

  const declareAttackers = () => {
    dispatch({ type: 'DECLARE_ATTACKERS', playerId: HUMAN_PLAYER_ID, attackerIds: [...attackerSelection] })
  }

  const declareBlockers = () => {
    const assignments = Object.fromEntries(Object.entries(blockAssignments).filter(([, blockers]) => blockers.length))
    for (const [attackerId, blockers] of Object.entries(assignments)) {
      const attacker = game.cards[attackerId]
      if (attacker && (attacker.keywords ?? []).includes('menace') && blockers.length < 2) {
        setToast(`${attacker.name} has menace - assign at least 2 blockers.`)
        return
      }
    }
    dispatch({ type: 'DECLARE_BLOCKERS', playerId: HUMAN_PLAYER_ID, assignments })
  }

  const toggleDiscardCard = (cardId: string) => {
    setDiscardSelection((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else if (next.size < pendingDiscardCount) next.add(cardId)
      return next
    })
  }

  const confirmDiscard = () => {
    const result = dispatch({ type: 'DISCARD_CARDS', playerId: HUMAN_PLAYER_ID, cardIds: [...discardSelection] })
    if (result) setDiscardSelection(new Set())
  }

  const primaryAction = () => {
    if (pendingDiscardCount > 0) {
      if (discardSelection.size === pendingDiscardCount) confirmDiscard()
      return
    }
    if (targetingId) {
      setTargetingId(null)
      setChosenTargets([])
      setToast('Targeting cancelled')
      return
    }
    if (selectedId) {
      beginCast(selectedId)
      return
    }
    if (game.phase === 'declare_attackers' && playerTurn && !game.combat.attackersDeclared) {
      declareAttackers()
      return
    }
    if (game.phase === 'declare_blockers' && game.combat.defendingPlayerId === HUMAN_PLAYER_ID && !game.combat.blockersDeclared) {
      declareBlockers()
      return
    }
    if (playerHasPriority) dispatch({ type: 'PASS_PRIORITY', playerId: HUMAN_PLAYER_ID })
  }

  const actionLabel = useMemo(() => {
    if (game.winnerId) return game.winnerId === HUMAN_PLAYER_ID ? 'Victory' : 'Defeat'
    if (game.isDraw) return 'Draw game'
    if (pendingDiscardCount > 0) return `Discard (${discardSelection.size}/${pendingDiscardCount})`
    if (orderingAttackerId) return 'Choose damage order'
    if (targetingId) return 'Cancel target'
    if (selected) return selected.types.includes('land') ? 'Play land' : `Cast · ${selected.manaCost ?? selected.manaValue ?? 0}`
    if (game.phase === 'declare_attackers' && playerTurn && !game.combat.attackersDeclared) return `Declare attackers (${attackerSelection.size})`
    if (game.phase === 'declare_blockers' && game.combat.defendingPlayerId === HUMAN_PLAYER_ID && !game.combat.blockersDeclared) {
      const blockers = Object.values(blockAssignments).reduce((sum, ids) => sum + ids.length, 0)
      return `Confirm blockers (${blockers})`
    }
    if (!playerHasPriority) return botThinking ? 'VEX_MAGE thinking' : 'Waiting for priority'
    if (game.stack.length > 0) return 'Resolve'
    if (playerTurn && game.phase === 'main1') return 'To Combat'
    if (playerTurn && game.phase === 'main2') return 'End Turn'
    return 'Next'
  }, [attackerSelection.size, blockAssignments, botThinking, discardSelection.size, game, orderingAttackerId, pendingDiscardCount, playerHasPriority, playerTurn, selected, targetingId])

  const canSelectHandCard = (cardId: string): boolean => handCardAvailability(cardId).playable

  const resetGame = () => {
    const next = makeGame()
    setGame(next)
    setSelectedId(null)
    setInspectedId(next.players[HUMAN_PLAYER_ID].zones.hand[0] ?? null)
    setTargetingId(null)
    setChosenTargets([])
    setAttackerSelection(new Set())
    setBlockingAttackerId(null)
    setBlockAssignments({})
    setPregame('review')
    setMulliganCount(0)
    setBottomSelection(new Set())
    setOpenZone(null)
    setTimer(0)
    setDiscardSelection(new Set())
    setOrderingAttackerId(null)
    setDamageOrderSelection([])
    setOrderedAttackerIds(new Set())
    setToast('Review your opening hand')
    previousLife.current = { human: 20, bot: 20 }
    previousStackIds.current = new Set()
    setAnnouncements([])
    hoverPauseUntilRef.current = 0
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const cardId = draggingId
    setDraggingId(null)
    if (cardId && canSelectHandCard(cardId)) beginCast(cardId)
  }

  const targetable = (target: TargetRef) => targetOptions.some((option) => targetEquals(option, target))
  const manaReady = (cardId: CardInstanceId) => checkAction(game, { type: 'TAP_FOR_MANA', playerId: HUMAN_PLAYER_ID, cardId }).legal
  // Only highlight a defender as clickable when it can legally block whichever attacker is currently selected
  // (flying/reach). Menace (needing 2+ blockers) is a set-level restriction, enforced on confirm instead.
  const canBlockSelectedAttacker = (cardId: CardInstanceId): boolean => {
    if (!blockingAttackerId) return true
    const attackerInstance = game.cards[blockingAttackerId]
    const blockerInstance = game.cards[cardId]
    return Boolean(attackerInstance && blockerInstance && canBlockAttacker(attackerInstance, blockerInstance))
  }
  const hiddenHand = game.players[BOT_PLAYER_ID].zones.hand
  const intentLinks = useMemo<IntentLink[]>(() => {
    const links: IntentLink[] = []
    const defenderId = game.combat.defendingPlayerId ?? BOT_PLAYER_ID
    const assignments = game.combat.blockersDeclared ? game.combat.blockers : blockAssignments

    for (const attackerId of game.combat.attackers.length ? game.combat.attackers : [...attackerSelection]) {
      const blockers = assignments[attackerId] ?? []
      if (!blockers.length) links.push({ from: { kind: 'card', id: attackerId }, to: { kind: 'player', id: defenderId }, tone: 'attack' })
      for (const blockerId of blockers) links.push({ from: { kind: 'card', id: blockerId }, to: { kind: 'card', id: attackerId }, tone: 'block' })
    }

    if (targetingId) {
      const chosenKeys = new Set(chosenTargets.map((target) => target.kind === 'player' ? `player:${target.playerId}` : target.kind === 'permanent' ? `card:${target.cardId}` : ''))
      for (const target of targetOptions) {
        if (target.kind === 'stack') continue
        const endpoint: IntentEndpoint = target.kind === 'player' ? { kind: 'player', id: target.playerId } : { kind: 'card', id: target.cardId }
        links.push({ from: { kind: 'card', id: targetingId }, to: endpoint, tone: 'target', preview: !chosenKeys.has(`${endpoint.kind}:${endpoint.id}`) })
      }
    }
    return links
  }, [attackerSelection, blockAssignments, chosenTargets, game.combat, targetOptions, targetingId])

  return (
    <LayoutGroup id="practice-arena">
    <main className={`game-shell ${draggingId ? 'is-dragging' : ''} ${dragDestination}`}>
      <IntentLines links={intentLinks} />
      <div className="ambient-light" />
      <header className="topbar">
        <button type="button" className="brand" onClick={onExit} title="Return to lobby"><span className="brand-mark"><Sparkles size={16} /></span><b>ARCANA</b><span>DUEL</span></button>
        <div className="match-meta"><span>PRACTICE · ENGINE</span><b><Clock3 size={13} /> {formattedTime}</b><span>TURN {game.turnNumber}</span></div>
        <nav className="top-actions" aria-label="Match actions">
          <button type="button" title="Game log" aria-label="Game log" onClick={() => setShowLog((value) => !value)}><History size={17} /></button>
          <button type="button" title={soundOn ? 'Mute sound' : 'Enable sound'} aria-label={soundOn ? 'Mute sound' : 'Enable sound'} onClick={() => setSoundOn((value) => !value)}><Volume2 size={17} className={soundOn ? '' : 'muted-icon'} /></button>
          <button type="button" title="Settings" aria-label="Settings" onClick={() => setShowSettings(true)}><Settings size={17} /></button>
          <button type="button" title="More match options" aria-label="More match options" onClick={() => setShowSettings(true)}><Menu size={19} /></button>
        </nav>
      </header>

      <aside className="inspector">
        <div className="inspector-heading"><Eye size={14} /><span>Card focus</span></div>
        <AnimatePresence mode="wait">
          <motion.div key={inspected.uid} className="preview-wrap" initial={{ opacity: 0, x: -15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}>
            <GameCard card={inspected} zone="preview" onClick={() => setZoomed(inspected)} />
          </motion.div>
        </AnimatePresence>
        <div className="oracle-copy">
          <div><span className={`color-pip ${inspected.color}`}>{manaIcon(inspected)}</span><b>{inspected.name}</b></div>
          <small>{inspected.typeLine}</small>
          <p>{inspected.rules || <i>No rules text.</i>}</p>
          {inspectedHandStatus && <div className={`inspector-status ${inspectedHandStatus.playable ? 'playable' : 'unavailable'}`}><span />{inspectedHandStatus.reason}</div>}
        </div>
      </aside>

      <button type="button" className="inspector-peek" onClick={() => setZoomed(inspected)} title="View full card text" aria-label={`View full card text for ${inspected.name}`}>
        <Eye size={12} />
        <b>{inspected.name}</b>
        <small>Tap to view text</small>
      </button>

      <section className="playmat">
        <div className="board-inscription top">ARCANA · RULES ARENA · ARCANA</div>
        <div className={`damage-vignette top ${damagePulse === 'opponent' ? 'show' : ''}`} />
        <div className={`damage-vignette bottom ${damagePulse === 'self' ? 'show' : ''}`} />

        <div className="opponent-zone">
          <PlayerBadge opponent life={opponentLife} active={game.priorityPlayerId === BOT_PLAYER_ID} targetable={targetable({ kind: 'player', playerId: BOT_PLAYER_ID })} onTarget={() => chooseTarget({ kind: 'player', playerId: BOT_PLAYER_ID })} onHover={pauseAutoFlow} />
          <div className="deck-pile opponent-deck" title="Opponent library" aria-label={`Opponent library, ${opponentLibraryCount} cards`}><Layers3 size={15} /><b>{opponentLibraryCount}</b></div>
          <button type="button" className="zone-pile opponent-graveyard" title="View opponent graveyard" aria-label={`View opponent graveyard, ${game.players[BOT_PLAYER_ID].zones.graveyard.length} cards`} onClick={() => setOpenZone({ playerId: BOT_PLAYER_ID, zone: 'graveyard' })}><Archive size={15} /><b>{game.players[BOT_PLAYER_ID].zones.graveyard.length}</b></button>
          <button type="button" className="zone-pile opponent-exile" title="View opponent exile" aria-label={`View opponent exile, ${game.players[BOT_PLAYER_ID].zones.exile.length} cards`} onClick={() => setOpenZone({ playerId: BOT_PLAYER_ID, zone: 'exile' })}><CircleOff size={15} /><b>{game.players[BOT_PLAYER_ID].zones.exile.length}</b></button>
          <div className="hidden-hand" aria-label={`Opponent has ${opponentHandCount} cards`}>
            <AnimatePresence initial={false}>
              {hiddenHand.map((cardId, index) => {
                const offset = index - (opponentHandCount - 1) / 2
                return <motion.span key={cardId} layout initial={{ opacity: 0, y: -28, scale: 0.85 }} animate={{ opacity: 1, x: offset * 10, y: 0, rotate: offset * 3, scale: 1 }} exit={{ opacity: 0, y: 45, scale: 0.8 }} transition={{ type: 'spring', stiffness: 390, damping: 31 }} />
              })}
            </AnimatePresence>
          </div>
          <div className="battle-row lands-row opponent-row" data-zone="Opponent resources">
            <div className="land-cluster">
              {opponentLandPiles.map((pile) => <div className={`land-pile ${pile[0].tapped ? 'is-tapped' : ''}`} key={`${pile[0].oracleName}-${pile[0].tapped ? 'tapped' : 'ready'}`}>
                <AnimatePresence>{pile.slice(0, 2).map((card, index) => <GameCard key={card.uid} card={card} zone="field" index={index} eligible={targetable({ kind: 'permanent', cardId: card.uid })} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => handleFieldCard(card, 'opponent')} onDoubleClick={() => setZoomed(card)} />)}</AnimatePresence>
                {pile.length > 1 && <span className="pile-count">×{pile.length}</span>}
              </div>)}
            </div>
            <div className="other-permanent-cluster">
              <AnimatePresence>{opponentOtherPermanents.map((card, index) => <GameCard key={card.uid} card={card} zone="field" index={index} eligible={targetable({ kind: 'permanent', cardId: card.uid })} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => handleFieldCard(card, 'opponent')} onDoubleClick={() => setZoomed(card)} />)}</AnimatePresence>
            </div>
          </div>
          <div className="battle-row creature-row opponent-row" data-zone="Opponent creatures">
            <AnimatePresence>{opponentCreatures.map((card, index) => <GameCard key={card.uid} card={card} zone="field" index={index} combatDirection={1} combatImpact={combatAnimating && (game.combat.attackers.includes(card.uid) || combatBlockerIds.has(card.uid))} eligible={targetable({ kind: 'permanent', cardId: card.uid }) || (game.phase === 'declare_blockers' && game.combat.attackers.includes(card.uid)) || (orderingAttackerId !== null && orderingBlockerIds.includes(card.uid) && !damageOrderSelection.includes(card.uid))} selected={card.uid === blockingAttackerId} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => handleFieldCard(card, 'opponent')} onDoubleClick={() => setZoomed(card)} />)}</AnimatePresence>
          </div>
        </div>

        <motion.div key={`${boardPrompt.title}-${boardPrompt.detail}`} className="board-status board-status-float" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}><div className="priority-gem" title={`${game.players[game.priorityPlayerId ?? HUMAN_PLAYER_ID]?.name ?? 'No player'} has priority`}><Zap size={12} /></div><span><b>{boardPrompt.title}</b><small>{boardPrompt.detail}</small></span></motion.div>
        <div className="midline" aria-hidden="true"><span /><i /><span /></div>

        <div className="player-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
          <div className="battle-row creature-row player-row" data-zone="Your creatures">
            <AnimatePresence>{creatures.map((card, index) => <GameCard key={card.uid} card={card} zone="field" index={index} combatDirection={-1} combatImpact={combatAnimating && (game.combat.attackers.includes(card.uid) || combatBlockerIds.has(card.uid))} manaReady={manaReady(card.uid)} eligible={legalAttackerIds.has(card.uid) || targetable({ kind: 'permanent', cardId: card.uid }) || (game.phase === 'declare_blockers' && game.combat.defendingPlayerId === HUMAN_PLAYER_ID && !game.combat.blockersDeclared && !card.tapped && canBlockSelectedAttacker(card.uid))} selected={attackerSelection.has(card.uid) || Object.values(blockAssignments).some((ids) => ids.includes(card.uid))} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => handleFieldCard(card, 'self')} onDoubleClick={() => setZoomed(card)} />)}</AnimatePresence>
          </div>
          <div className="battle-row lands-row player-row" data-zone="Your resources">
            <div className="land-cluster">
              {playerLandPiles.map((pile) => <div className={`land-pile ${pile[0].tapped ? 'is-tapped' : ''}`} key={`${pile[0].oracleName}-${pile[0].tapped ? 'tapped' : 'ready'}`}>
                <AnimatePresence>{pile.slice(0, 2).map((card, index) => <GameCard key={card.uid} card={card} zone="field" index={index} manaReady={manaReady(card.uid)} eligible={targetable({ kind: 'permanent', cardId: card.uid })} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => handleFieldCard(card, 'self')} onDoubleClick={() => setZoomed(card)} />)}</AnimatePresence>
                {pile.length > 1 && <span className="pile-count">×{pile.length}</span>}
              </div>)}
            </div>
            <div className="other-permanent-cluster">
              <AnimatePresence>{otherPermanents.map((card, index) => <GameCard key={card.uid} card={card} zone="field" index={index} manaReady={manaReady(card.uid)} eligible={targetable({ kind: 'permanent', cardId: card.uid })} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => handleFieldCard(card, 'self')} onDoubleClick={() => setZoomed(card)} />)}</AnimatePresence>
            </div>
          </div>
          <PlayerBadge life={playerLife} active={playerHasPriority} targetable={targetable({ kind: 'player', playerId: HUMAN_PLAYER_ID })} onTarget={() => chooseTarget({ kind: 'player', playerId: HUMAN_PLAYER_ID })} onHover={pauseAutoFlow} />
          <div className="deck-pile self-deck" title={`${libraryCount} cards in library`} aria-label={`Your library, ${libraryCount} cards`}><Layers3 size={15} /><b>{libraryCount}</b></div>
          <button type="button" className="zone-pile self-graveyard" title="View your graveyard" aria-label={`View your graveyard, ${game.players[HUMAN_PLAYER_ID].zones.graveyard.length} cards`} onClick={() => setOpenZone({ playerId: HUMAN_PLAYER_ID, zone: 'graveyard' })}><Archive size={15} /><b>{game.players[HUMAN_PLAYER_ID].zones.graveyard.length}</b></button>
          <button type="button" className="zone-pile self-exile" title="View your exile" aria-label={`View your exile, ${game.players[HUMAN_PLAYER_ID].zones.exile.length} cards`} onClick={() => setOpenZone({ playerId: HUMAN_PLAYER_ID, zone: 'exile' })}><CircleOff size={15} /><b>{game.players[HUMAN_PLAYER_ID].zones.exile.length}</b></button>
        </div>

        <AnimatePresence>
          {topStackItem && stackCard && (
            <motion.aside className="stack-zone" aria-label={`Stack with ${game.stack.length} object${game.stack.length === 1 ? '' : 's'}`} initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 28 }}>
              <div className="stack-heading"><Layers3 size={14} /><span>Stack</span><b>{game.stack.length}</b></div>
              <div className="stack-cards">
                {game.stack.map((item, index) => {
                  const card = engineCardToView(game.cards[item.sourceId])
                  const isTop = index === game.stack.length - 1
                  return <motion.div key={item.id} className={`stack-card-shell ${isTop ? 'top' : ''}`} style={{ zIndex: index + 1 }} initial={{ opacity: 0, x: 35, scale: .86 }} animate={{ opacity: 1, x: index * 8, y: index * 9, rotate: (index - game.stack.length / 2) * 1.1, scale: 1 }} exit={{ opacity: 0, scale: 1.18, filter: 'brightness(2)' }} transition={{ type: 'spring', stiffness: 360, damping: 29 }}>
                    <GameCard card={card} zone="stack" eligible={targetable({ kind: 'stack', stackItemId: item.id })} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => chooseTarget({ kind: 'stack', stackItemId: item.id })} onDoubleClick={() => setZoomed(card)} />
                    {isTop && <div className="resolve-ring" />}
                  </motion.div>
                })}
              </div>
              <div className="stack-summary"><b>{topStackItem.name}</b><small>Resolves first</small></div>
            </motion.aside>
          )}
        </AnimatePresence>
        <div className="stack-drop-hint"><Layers3 size={18} /><span>Stack</span></div>
      </section>

      <section className="hand-zone">
        <div className="hand-toolbar">
          <div className="hand-label"><Hand size={13} /> HAND <span>{hand.length}</span></div>
          <label className="hand-sort">
            <ArrowDownWideNarrow size={14} aria-hidden="true" />
            <span>Sort</span>
            <select
              aria-label="Sort cards in hand"
              value={handSort}
              onChange={(event) => {
                const next = event.target.value
                if (isHandSortMode(next)) setHandSort(next)
              }}
            >
              {HAND_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <div className="hand-cards">
          <AnimatePresence initial={false}>
            {sortedHand.map((card, index) => {
              const enabled = canSelectHandCard(card.uid)
              return (
                <GameCard
                  key={card.uid}
                  card={card}
                  zone="hand"
                  index={index}
                  selected={card.uid === selectedId}
                  disabled={!enabled}
                  onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }}
                  onClick={() => { if (enabled) setSelectedId((id) => id === card.uid ? null : card.uid); setInspectedId(card.uid) }}
                  onDragStart={() => { if (enabled) { setDraggingId(card.uid); setSelectedId(card.uid) } }}
                  onDragEnd={() => setDraggingId(null)}
                  onDoubleClick={() => setZoomed(card)}
                />
              )
            })}
          </AnimatePresence>
        </div>
      </section>

      <div className="action-dock" aria-label="Current action">
        <div className="mana-readout" title={`${readyMana.sources} untapped mana sources; ${manaInPool} floating`}><span className={`mana-orb green ${readyMana.colors.has('G') ? 'available' : ''}`}><Leaf size={12} /></span><span className={`mana-orb red ${readyMana.colors.has('R') ? 'available' : ''}`}><Flame size={12} /></span><b>{readyMana.sources + manaInPool}</b><small className="mana-readout-full">{manaInPool ? `${manaInPool} floating` : 'mana ready'}</small><small className="mana-readout-compact">mana</small></div>
        <button type="button" className="primary-action" disabled={(!playerHasPriority && !(game.phase === 'declare_blockers' && game.combat.defendingPlayerId === HUMAN_PLAYER_ID && !game.combat.blockersDeclared)) || botThinking || !!game.winnerId || game.isDraw} onClick={primaryAction}>
          <span>{actionLabel}</span><ChevronRight size={18} />
        </button>
      </div>

      <AnimatePresence>
        {toast && <motion.div className="toast" role="status" aria-live="polite" initial={{ y: -16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }}><Sparkles size={14} />{toast}</motion.div>}
      </AnimatePresence>

      <AnimatePresence>
        {activeAnnouncement && (
          <motion.div
            key={activeAnnouncement.id}
            className="spell-announcement"
            aria-live="polite"
            initial={{ opacity: 0, scale: 0.72 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.08 }}
            transition={{ duration: 0.32, ease: 'easeOut' }}
          >
            <div className="spell-announcement-card">
              <GameCard card={activeAnnouncement.card} zone="preview" />
            </div>
            <div className="spell-announcement-name">{activeAnnouncement.card.name}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLog && (
          <motion.aside className="log-panel" initial={{ x: 320 }} animate={{ x: 0 }} exit={{ x: 320 }}>
            <div className="panel-title"><div><History size={16} /><b>Game log</b></div><button type="button" aria-label="Close game log" onClick={() => setShowLog(false)}><X size={17} /></button></div>
            <div className="log-list">{[...log].reverse().map((item) => <div key={item.id} className={item.tone}><span />{item.text}</div>)}</div>
            <button type="button" className="chat-row"><MessageCircle size={15} /> Send message</button>
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSettings && (
          <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowSettings(false)}>
            <motion.div className="settings-modal" role="dialog" aria-modal="true" aria-label="Match settings" initial={{ scale: 0.94, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }} onClick={(event) => event.stopPropagation()}>
              <div className="panel-title"><div><Settings size={16} /><b>Match settings</b></div><button type="button" aria-label="Close settings" onClick={() => setShowSettings(false)}><X size={17} /></button></div>
              <label><span><Volume2 size={16} /> Sound</span><button type="button" role="switch" aria-label="Sound" aria-checked={soundOn} className={`toggle ${soundOn ? 'on' : ''}`} onClick={() => setSoundOn((value) => !value)}><i /></button></label>
              <label><span><Shield size={16} /> Auto-skip</span><button type="button" role="switch" aria-label="Auto-skip" aria-checked={autoPass} className={`toggle ${autoPass ? 'on' : ''}`} onClick={() => setAutoPass((value) => !value)}><i /></button></label>
              <button type="button" className="concede" onClick={resetGame}>Restart match</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {openZone && (
          <motion.div className="zone-browser-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpenZone(null)}>
            <motion.section className="zone-browser" role="dialog" aria-modal="true" aria-label={`${game.players[openZone.playerId].name} ${openZone.zone}`} initial={{ opacity: 0, y: 32, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: .98 }} onClick={(event) => event.stopPropagation()}>
              <header><div>{openZone.zone === 'graveyard' ? <Archive size={18} /> : <CircleOff size={18} />}<span><b>{game.players[openZone.playerId].name}</b><small>{openZone.zone} · {openZoneCards.length} cards</small></span></div><button type="button" aria-label="Close zone browser" onClick={() => setOpenZone(null)}><X size={18} /></button></header>
              <div className="zone-browser-cards">
                {openZoneCards.length ? openZoneCards.map((card, index) => <GameCard key={card.uid} card={card} zone="preview" index={index} onHover={() => { setInspectedId(card.uid); pauseAutoFlow() }} onClick={() => setZoomed(card)} />) : <div className="zone-empty"><Layers3 size={28} /><b>No cards here</b></div>}
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pregame !== 'done' && (
          <motion.section className="mulligan-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="mulligan-panel" initial={{ y: 35, scale: .97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: .98 }}>
              <div className="mulligan-heading">
                <span>{pregame === 'review' ? 'Opening hand' : 'London mulligan'}</span>
                <h1>{pregame === 'review' ? 'Keep or mulligan?' : `Put ${mulliganCount} on the bottom`}</h1>
                <p>{pregame === 'review' ? `${deck.name} · ${deck.format} · You play first and skip your first draw step.` : `Select exactly ${mulliganCount} card${mulliganCount === 1 ? '' : 's'} from your hand.`}</p>
              </div>
              <p className="mulligan-hint">Click any card to read it up close, or hover to see it larger.</p>
              <div className="mulligan-hand">
                {sortedHand.map((card, index) => (
                  <motion.button
                    type="button"
                    key={card.uid}
                    className={`mulligan-card ${bottomSelection.has(card.uid) ? 'chosen' : ''}`}
                    onClick={() => pregame === 'bottom' ? toggleBottomCard(card.uid) : setZoomed(card)}
                    onDoubleClick={() => setZoomed(card)}
                    initial={{ opacity: 0, y: 55, rotate: (index - 3) * 2 }}
                    animate={{ opacity: 1, y: bottomSelection.has(card.uid) ? 17 : 0, rotate: (index - 3) * 1.2 }}
                    transition={{ type: 'spring', stiffness: 270, damping: 24, delay: index * .045 }}
                    whileHover={{ y: -22, scale: 1.16, zIndex: 10 }}
                  >
                    <img src={card.image} alt={card.name} />
                    {bottomSelection.has(card.uid) && <span>Bottom</span>}
                  </motion.button>
                ))}
              </div>
              <div className="mulligan-actions">
                {pregame === 'review'
                  ? <><button type="button" className="mulligan-secondary" onClick={takeMulligan} disabled={mulliganCount >= 6}>Mulligan <small>{mulliganCount ? `Keep ${6 - mulliganCount}` : 'Draw a new seven'}</small></button><button type="button" className="mulligan-keep" onClick={keepOpeningHand}>Keep hand <ChevronRight /></button></>
                  : <button type="button" className="mulligan-keep" disabled={bottomSelection.size !== mulliganCount} onClick={confirmBottom}>Confirm {bottomSelection.size}/{mulliganCount} <ChevronRight /></button>}
              </div>
              <button type="button" className="mulligan-exit" onClick={onExit}><X /> Return to lobby</button>
            </motion.div>
          </motion.section>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {pregame === 'done' && pendingDiscardCount > 0 && (
          <motion.section className="mulligan-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="mulligan-panel" initial={{ y: 35, scale: .97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, scale: .98 }}>
              <div className="mulligan-heading">
                <span>Maximum hand size</span>
                <h1>Discard {pendingDiscardCount} card{pendingDiscardCount === 1 ? '' : 's'}</h1>
                <p>You have more than {MAX_HAND_SIZE} cards in hand at cleanup. Select exactly {pendingDiscardCount} to discard.</p>
              </div>
              <p className="mulligan-hint">Click any card to read it up close, or hover to see it larger.</p>
              <div className="mulligan-hand">
                {sortedHand.map((card, index) => (
                  <motion.button
                    type="button"
                    key={card.uid}
                    className={`mulligan-card ${discardSelection.has(card.uid) ? 'chosen' : ''}`}
                    onClick={() => toggleDiscardCard(card.uid)}
                    onDoubleClick={() => setZoomed(card)}
                    initial={{ opacity: 0, y: 55, rotate: (index - 3) * 2 }}
                    animate={{ opacity: 1, y: discardSelection.has(card.uid) ? 17 : 0, rotate: (index - 3) * 1.2 }}
                    transition={{ type: 'spring', stiffness: 270, damping: 24, delay: index * .045 }}
                    whileHover={{ y: -22, scale: 1.16, zIndex: 10 }}
                  >
                    <img src={card.image} alt={card.name} />
                    {discardSelection.has(card.uid) && <span>Discard</span>}
                  </motion.button>
                ))}
              </div>
              <div className="mulligan-actions">
                <button type="button" className="mulligan-keep" disabled={discardSelection.size !== pendingDiscardCount} onClick={confirmDiscard}>Discard {discardSelection.size}/{pendingDiscardCount} <ChevronRight /></button>
              </div>
            </motion.div>
          </motion.section>
        )}
      </AnimatePresence>
      <CardZoom card={zoomCard} onClose={() => setZoomed(null)} />
      <span className="sr-only" aria-live="polite">{getPhaseLabel(game.phase)}. {game.players[game.priorityPlayerId ?? HUMAN_PLAYER_ID]?.name ?? 'No player'} has priority.</span>
      <span className="sr-only">Arena phase group: {legacyPhase}</span>
    </main>
    </LayoutGroup>
  )
}
