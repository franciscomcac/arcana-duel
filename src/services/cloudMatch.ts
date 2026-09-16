import type { RealtimeChannel } from '@supabase/supabase-js'
import type { CatalogCard } from '../catalog'
import {
  createCloudPlayerState,
  parseCloudLobby,
  snapshotToCloudRoom,
  type CloudLobbyState,
  type CloudRoom,
} from './cloudMatchModel'
import type { MatchSnapshot } from './matchRealtime'
import { ensureAnonymousSession, requireSupabase } from './supabase'

export type CloudRoomInput = {
  playerName: string
  deckName: string
  deck: CatalogCard[]
  roomName: string
  format: string
  privacy: string
}

export type CloudPlayerInput = Omit<CloudRoomInput, 'roomName' | 'privacy'>

export type CloudMatchAction =
  | { type: 'play'; payload: { uid: string } }
  | { type: 'tap'; payload: { uid: string } }
  | { type: 'life'; payload: { delta: number } }
  | { type: 'pass'; payload?: Record<string, never> }
  | { type: 'end'; payload?: Record<string, never> }

export type CloudLobbySubscription = {
  channel: RealtimeChannel
  notify: () => Promise<void>
  unsubscribe: () => ReturnType<ReturnType<typeof requireSupabase>['removeChannel']>
}

function snapshot(data: unknown): MatchSnapshot {
  if (!data || typeof data !== 'object' || typeof (data as MatchSnapshot).id !== 'string') {
    throw new Error('Supabase returned an invalid match snapshot.')
  }
  return data as MatchSnapshot
}

async function cloudIdentity(displayName: string) {
  const session = await ensureAnonymousSession(displayName)
  return { session, userId: session.user.id }
}

function playerPayload(userId: string, input: CloudPlayerInput, index: number) {
  return {
    id: userId,
    name: input.playerName.trim().slice(0, 32) || 'Planeswalker',
    deckName: input.deckName.trim().slice(0, 80) || 'Starter Deck',
    ready: false,
    player: createCloudPlayerState(userId, input.playerName, input.deck, index),
  }
}

export async function getCloudUserId(displayName = 'Planeswalker'): Promise<string> {
  return (await cloudIdentity(displayName)).userId
}

export async function fetchCloudLobby(online = 1): Promise<CloudLobbyState> {
  await cloudIdentity('Planeswalker')
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_cloud_lobby')
  if (error) throw error
  return parseCloudLobby(data, online)
}

export function subscribeToCloudLobby(
  userId: string,
  handlers: {
    onRefresh: () => void
    onPresence: (online: number) => void
    onStatus: (connected: boolean) => void
  },
): CloudLobbySubscription {
  const client = requireSupabase()
  const channel = client
    .channel('arcana:lobby:v1', {
      config: { broadcast: { self: false }, presence: { key: userId } },
    })
    .on('broadcast', { event: 'refresh' }, () => handlers.onRefresh())
    .on('presence', { event: 'sync' }, () => {
      const presence = channel.presenceState()
      const uniqueUsers = new Set<string>()
      Object.values(presence).flat().forEach((entry) => {
        const candidate = entry as { userId?: unknown }
        if (typeof candidate.userId === 'string') uniqueUsers.add(candidate.userId)
      })
      handlers.onPresence(Math.max(1, uniqueUsers.size))
    })
    .subscribe((status) => {
      const connected = status === 'SUBSCRIBED'
      handlers.onStatus(connected)
      if (connected) {
        void channel.track({ userId, onlineAt: new Date().toISOString() })
      }
    })

  return {
    channel,
    notify: async () => {
      const status = await channel.send({ type: 'broadcast', event: 'refresh', payload: { userId } })
      if (status !== 'ok') throw new Error(`Lobby broadcast failed: ${status}`)
    },
    unsubscribe: () => client.removeChannel(channel),
  }
}

export async function createCloudRoom(input: CloudRoomInput): Promise<CloudRoom> {
  const { userId } = await cloudIdentity(input.playerName)
  const client = requireSupabase()
  const { data, error } = await client.rpc('create_cloud_match', {
    p_room_name: input.roomName.trim().slice(0, 80) || `${input.playerName}'s table`,
    p_format: input.format.trim().slice(0, 32) || 'Standard',
    p_privacy: input.privacy,
    p_host_player: playerPayload(userId, input, 0),
  })
  if (error) throw error
  return snapshotToCloudRoom(snapshot(data))
}

export async function joinCloudRoom(roomId: string, input: CloudPlayerInput): Promise<CloudRoom> {
  const { userId } = await cloudIdentity(input.playerName)
  const client = requireSupabase()
  const { data, error } = await client.rpc('join_cloud_match', {
    p_match_id: roomId,
    p_guest_player: playerPayload(userId, input, 1),
  })
  if (error) throw error
  return snapshotToCloudRoom(snapshot(data))
}

export async function setCloudRoomReady(roomId: string, ready: boolean): Promise<MatchSnapshot> {
  await cloudIdentity('Planeswalker')
  const client = requireSupabase()
  const { data, error } = await client.rpc('set_cloud_match_ready', {
    p_match_id: roomId,
    p_ready: ready,
  })
  if (error) throw error
  return snapshot(data)
}

export async function findCloudQuickMatch(input: CloudPlayerInput): Promise<MatchSnapshot> {
  const { userId } = await cloudIdentity(input.playerName)
  const client = requireSupabase()
  const { data, error } = await client.rpc('find_or_create_cloud_quick_match', {
    p_format: input.format.trim().slice(0, 32) || 'Standard',
    p_player: { ...playerPayload(userId, input, 0), ready: true },
  })
  if (error) throw error
  return snapshot(data)
}

export async function leaveCloudRoom(roomId: string): Promise<MatchSnapshot> {
  await cloudIdentity('Planeswalker')
  const client = requireSupabase()
  const { data, error } = await client.rpc('leave_cloud_match', { p_match_id: roomId })
  if (error) throw error
  return snapshot(data)
}

export async function fetchCloudMatch(roomId: string): Promise<MatchSnapshot> {
  await cloudIdentity('Planeswalker')
  const client = requireSupabase()
  const { data, error } = await client
    .from('live_matches')
    .select('*')
    .eq('id', roomId)
    .single()
  if (error) throw error
  return snapshot(data)
}

export async function applyCloudMatchAction(
  roomId: string,
  action: CloudMatchAction,
): Promise<MatchSnapshot> {
  await cloudIdentity('Planeswalker')
  const client = requireSupabase()
  const { data, error } = await client.rpc('apply_cloud_match_action', {
    p_match_id: roomId,
    p_action_type: action.type,
    p_payload: action.payload || {},
  })
  if (error) throw error
  return snapshot(data)
}
