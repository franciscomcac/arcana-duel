import type { CatalogCard } from '../catalog'
import type { MatchSnapshot } from './matchRealtime'

export type RemoteCard = {
  uid: string
  id: string
  name: string
  image: string
  kind: string
  cost: number
  mana?: string
  typeLine?: string
  rules?: string
  color?: CatalogCard['color']
  rarity?: CatalogCard['rarity']
  power?: number | null
  toughness?: number | null
  tapped?: boolean
}

export type PlayerState = {
  id: string
  name: string
  life: number
  hand: RemoteCard[]
  library: RemoteCard[]
  battlefield: RemoteCard[]
  graveyard: RemoteCard[]
  index: number
  landsPlayedThisTurn?: number
}

export type RemoteStackItem = {
  id: string
  controller: number
  card: RemoteCard
}

export type MatchState = {
  turn: number
  activePlayer: number
  priorityPlayer: number
  consecutivePasses: number
  phase: string
  stack: RemoteStackItem[]
  players: PlayerState[]
  log: { id: number; text: string }[]
}

export type CloudRoomPlayer = {
  id: string
  name: string
  deckName: string
  ready: boolean
}

export type CloudRoom = {
  id: string
  code: string
  name: string
  format: string
  privacy: string
  status: string
  players: CloudRoomPlayer[]
  spectators: number
  createdAt: number
}

export type CloudLobbyState = {
  rooms: CloudRoom[]
  online: number
  queued: number
}

type LobbyPlayerPayload = CloudRoomPlayer & { player?: PlayerState }

type CloudBattlefieldState = {
  lobby?: {
    name?: string
    privacy?: string
    createdAt?: number
    host?: LobbyPlayerPayload
    guest?: LobbyPlayerPayload | null
  }
  game?: MatchState | null
}

function makeUid(cardId: string, index: number): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${cardId}-${index}-${random}`
}

function toRemoteCard(card: CatalogCard, index: number): RemoteCard {
  return {
    uid: makeUid(card.id, index),
    id: card.id,
    name: card.name,
    image: card.image,
    kind: card.kind,
    cost: card.cost,
    mana: card.mana,
    typeLine: card.typeLine,
    rules: card.rules,
    color: card.color,
    rarity: card.rarity,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    tapped: false,
  }
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = random()
    const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(sample, 0.9999999999999999)) : 0
    const swapIndex = Math.floor(normalized * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

export function createCloudPlayerState(
  userId: string,
  name: string,
  cards: CatalogCard[],
  index: number,
  random: () => number = Math.random,
): PlayerState {
  const hydrated = shuffled(cards.map(toRemoteCard), random)
  return {
    id: userId,
    name: name.trim().slice(0, 32) || 'Planeswalker',
    life: 20,
    hand: hydrated.slice(0, 7),
    library: hydrated.slice(7),
    battlefield: [],
    graveyard: [],
    index,
    landsPlayedThisTurn: 0,
  }
}

function isPlayerState(value: unknown): value is PlayerState {
  if (!value || typeof value !== 'object') return false
  const player = value as Partial<PlayerState>
  return typeof player.id === 'string'
    && typeof player.name === 'string'
    && Number.isFinite(player.life)
    && (player.index === 0 || player.index === 1)
    && isCardArray(player.hand)
    && isCardArray(player.library)
    && isCardArray(player.battlefield)
    && isCardArray(player.graveyard)
    && (player.landsPlayedThisTurn === undefined || (Number.isInteger(player.landsPlayedThisTurn) && Number(player.landsPlayedThisTurn) >= 0))
}

function isRemoteCard(value: unknown): value is RemoteCard {
  if (!value || typeof value !== 'object') return false
  const card = value as Partial<RemoteCard>
  return typeof card.uid === 'string'
    && card.uid.length > 0
    && typeof card.id === 'string'
    && typeof card.name === 'string'
    && typeof card.image === 'string'
    && typeof card.kind === 'string'
    && Number.isFinite(card.cost)
    && (card.mana === undefined || typeof card.mana === 'string')
    && (card.typeLine === undefined || typeof card.typeLine === 'string')
    && (card.rules === undefined || typeof card.rules === 'string')
    && (card.tapped === undefined || typeof card.tapped === 'boolean')
}

function isCardArray(value: unknown): value is RemoteCard[] {
  return Array.isArray(value) && value.every(isRemoteCard)
}

function isStackItem(value: unknown): value is RemoteStackItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RemoteStackItem>
  return typeof item.id === 'string'
    && (item.controller === 0 || item.controller === 1)
    && isRemoteCard(item.card)
}

export function snapshotToMatchState(snapshot: MatchSnapshot): MatchState | null {
  if (!snapshot.battlefield_state || typeof snapshot.battlefield_state !== 'object') return null
  const battlefield = snapshot.battlefield_state as CloudBattlefieldState
  const game = battlefield.game
  if (!game || !Array.isArray(game.players) || game.players.length !== 2) return null
  if (!game.players.every(isPlayerState)) return null
  if (game.players[0].index !== 0 || game.players[1].index !== 1) return null
  const turn = Number(game.turn)
  return {
    turn: Number.isSafeInteger(turn) && turn > 0 ? turn : Math.max(1, snapshot.turn_number || 1),
    activePlayer: Number(game.activePlayer) === 1 ? 1 : 0,
    priorityPlayer: Number((game as MatchState).priorityPlayer) === 1 ? 1 : 0,
    consecutivePasses: Math.max(0, Number((game as MatchState).consecutivePasses) || 0),
    phase: typeof game.phase === 'string' ? game.phase : snapshot.phase,
    stack: Array.isArray((game as MatchState).stack) ? (game as MatchState).stack.filter(isStackItem) : [],
    players: game.players,
    log: Array.isArray(game.log)
      ? game.log.filter((entry): entry is { id: number; text: string } => {
          if (!entry || typeof entry !== 'object') return false
          const candidate = entry as { id?: unknown; text?: unknown }
          return typeof candidate.id === 'number' && typeof candidate.text === 'string'
        })
      : [],
  }
}

function isCloudRoomPlayer(value: unknown): value is LobbyPlayerPayload {
  if (!value || typeof value !== 'object') return false
  const player = value as Partial<CloudRoomPlayer>
  return typeof player.id === 'string'
    && player.id.length > 0
    && typeof player.name === 'string'
    && typeof player.deckName === 'string'
    && typeof player.ready === 'boolean'
}

export function snapshotToCloudRoom(snapshot: MatchSnapshot): CloudRoom {
  const battlefield = snapshot.battlefield_state as CloudBattlefieldState
  const lobby = battlefield.lobby
  const players = [lobby?.host, lobby?.guest]
    .filter(isCloudRoomPlayer)
    .map(({ id, name, deckName, ready }) => ({ id, name, deckName, ready }))

  return {
    id: snapshot.id,
    code: snapshot.id.slice(0, 8).toUpperCase(),
    name: lobby?.name || 'Arcana table',
    format: snapshot.format || 'Standard',
    privacy: lobby?.privacy || 'Public',
    status: snapshot.status,
    players,
    spectators: 0,
    createdAt: lobby?.createdAt || Date.parse(snapshot.created_at || '') || Date.now(),
  }
}

export function parseCloudLobby(value: unknown, online = 1): CloudLobbyState {
  if (!value || typeof value !== 'object') return { rooms: [], online, queued: 0 }
  const payload = value as { rooms?: unknown[]; queued?: number }
  const rooms = Array.isArray(payload.rooms)
    ? payload.rooms.flatMap((room) => {
        if (!room || typeof room !== 'object') return []
        const candidate = room as Partial<CloudRoom> & { created_at?: string }
        if (typeof candidate.id !== 'string') return []
        const players = Array.isArray(candidate.players)
          ? candidate.players.filter(isCloudRoomPlayer)
          : []
        return [{
          id: candidate.id,
          code: candidate.code || candidate.id.slice(0, 8).toUpperCase(),
          name: candidate.name || 'Arcana table',
          format: candidate.format || 'Standard',
          privacy: candidate.privacy || 'Public',
          status: candidate.status || 'waiting',
          players,
          spectators: Number(candidate.spectators) || 0,
          createdAt: Number(candidate.createdAt) || Date.parse(candidate.created_at || '') || Date.now(),
        } satisfies CloudRoom]
      })
    : []
  return { rooms, online, queued: Number(payload.queued) || 0 }
}
