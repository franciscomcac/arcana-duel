import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { requireSupabase } from './supabase'

export type MatchEventType =
  | 'move_card'
  | 'set_tapped'
  | 'set_counter'
  | 'adjust_life'
  | 'cast_spell'
  | 'activate_ability'
  | 'pass_priority'
  | 'resolve_stack'
  | 'advance_phase'
  | 'declare_attacker'
  | 'declare_blocker'
  | 'concede'
  | 'snapshot'

export type MatchEvent = {
  id?: number
  match_id: string
  actor_id: string
  sequence: number
  event_type: MatchEventType
  payload: Record<string, unknown>
  created_at?: string
}

export type MatchSnapshot = {
  id: string
  host_id: string
  guest_id: string | null
  status: 'waiting' | 'active' | 'complete' | 'abandoned'
  turn_number: number
  active_player: string
  priority_player: string
  phase: string
  stack: unknown[]
  battlefield_state: Record<string, unknown>
  life_totals: Record<string, number>
  version: number
  format: string
  created_at?: string
  updated_at?: string
}

export type MatchChatPayload = {
  id: number
  actorId: string
  text: string
}

export type MatchUpdate = Partial<Pick<
  MatchSnapshot,
  'phase' | 'active_player' | 'priority_player' | 'stack' | 'battlefield_state' | 'life_totals'
>>

type MatchSubscription = {
  channel: RealtimeChannel
  unsubscribe: () => ReturnType<ReturnType<typeof requireSupabase>['removeChannel']>
}

export function subscribeToMatch(
  matchId: string,
  handlers: {
    onEvent: (event: MatchEvent) => void
    onSnapshot: (snapshot: MatchSnapshot) => void
    onPresence?: (players: Record<string, unknown[]>) => void
    onChat?: (message: MatchChatPayload) => void
    onStatus?: (status: string) => void
  },
): MatchSubscription {
  const client = requireSupabase()
  const channel = client
    .channel(`match:${matchId}`, { config: { broadcast: { self: true }, presence: { key: matchId } } })
    .on('broadcast', { event: 'match_event' }, ({ payload }) => handlers.onEvent(payload as MatchEvent))
    .on('broadcast', { event: 'match_chat' }, ({ payload }) => handlers.onChat?.(payload as MatchChatPayload))
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'live_matches', filter: `id=eq.${matchId}` },
      (payload: RealtimePostgresChangesPayload<MatchSnapshot>) => handlers.onSnapshot(payload.new as MatchSnapshot),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'match_events', filter: `match_id=eq.${matchId}` },
      (payload: RealtimePostgresChangesPayload<MatchEvent>) => handlers.onEvent(payload.new as MatchEvent),
    )
    .on('presence', { event: 'sync' }, () => handlers.onPresence?.(channel.presenceState()))
    .subscribe((status) => handlers.onStatus?.(status))

  return { channel, unsubscribe: () => client.removeChannel(channel) }
}

export async function broadcastMatchChat(channel: RealtimeChannel, message: MatchChatPayload) {
  const cappedMessage = { ...message, text: message.text.slice(0, 240) }
  const status = await channel.send({ type: 'broadcast', event: 'match_chat', payload: cappedMessage })
  if (status !== 'ok') throw new Error(`Realtime chat failed: ${status}`)
}

export async function broadcastMatchEvent(channel: RealtimeChannel, event: MatchEvent) {
  const status = await channel.send({ type: 'broadcast', event: 'match_event', payload: event })
  if (status !== 'ok') throw new Error(`Realtime broadcast failed: ${status}`)
}

