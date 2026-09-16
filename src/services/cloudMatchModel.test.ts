import { describe, expect, it } from 'vitest'
import type { CatalogCard } from '../catalog'
import type { MatchSnapshot } from './matchRealtime'
import {
  createCloudPlayerState,
  parseCloudLobby,
  snapshotToCloudRoom,
  snapshotToMatchState,
} from './cloudMatchModel'

const card = (id: string, kind: CatalogCard['kind'] = 'creature'): CatalogCard => ({
  id,
  name: id,
  image: `/${id}.jpg`,
  color: 'green',
  kind,
  cost: kind === 'land' ? 0 : 1,
  mana: kind === 'land' ? 'G' : '1',
  typeLine: kind,
  rules: '',
  rarity: 'Common',
})

const snapshot = (game: unknown): MatchSnapshot => ({
  id: 'match-id',
  host_id: 'host',
  guest_id: 'guest',
  status: 'active',
  turn_number: 3,
  active_player: 'host',
  priority_player: 'host',
  phase: 'precombat_main',
  stack: [],
  battlefield_state: { game },
  life_totals: { host: 20, guest: 20 },
  version: 1,
  format: 'Standard',
})

describe('cloud match model', () => {
  it('shuffles grouped decklists before drawing an opening hand', () => {
    const cards = [
      ...Array.from({ length: 7 }, (_, index) => card(`land-${index}`, 'land')),
      ...Array.from({ length: 7 }, (_, index) => card(`spell-${index}`)),
    ]
    const player = createCloudPlayerState('player', 'Mage', cards, 0, () => 0)

    expect(player.hand).toHaveLength(7)
    expect(player.hand.some((item) => item.kind !== 'land')).toBe(true)
    expect([...player.hand, ...player.library]).toHaveLength(cards.length)
  })

  it('rejects malformed cards and mismatched player indexes from realtime snapshots', () => {
    const host = createCloudPlayerState('host', 'Host', [card('host-card')], 0, () => 0)
    const guest = createCloudPlayerState('guest', 'Guest', [card('guest-card')], 1, () => 0)
    const valid = { turn: 1, activePlayer: 0, phase: 'main', players: [host, guest], log: [] }

    expect(snapshotToMatchState(snapshot(valid))).not.toBeNull()
    expect(snapshotToMatchState(snapshot({ ...valid, players: [host, { ...guest, index: 0 }] }))).toBeNull()
    expect(snapshotToMatchState(snapshot({ ...valid, players: [{ ...host, hand: [{}] }, guest] }))).toBeNull()
  })

  it('drops malformed log and lobby entries instead of exposing them to React', () => {
    const host = createCloudPlayerState('host', 'Host', [], 0, () => 0)
    const guest = createCloudPlayerState('guest', 'Guest', [], 1, () => 0)
    const state = snapshotToMatchState(snapshot({
      turn: -4,
      activePlayer: 0,
      phase: 'main',
      players: [host, guest],
      log: [null, { id: 1, text: 'Valid' }, { id: 'bad', text: 2 }],
    }))
    const lobby = parseCloudLobby({
      rooms: [{
        id: 'room-id',
        players: [null, { id: 'host', name: 'Host', deckName: 'Deck', ready: false }],
      }],
    })

    expect(state?.turn).toBe(3)
    expect(state?.log).toEqual([{ id: 1, text: 'Valid' }])
    expect(lobby.rooms[0].players).toEqual([{ id: 'host', name: 'Host', deckName: 'Deck', ready: false }])
  })

  it('filters partial players from direct room snapshots', () => {
    const value = snapshot(null)
    value.battlefield_state = {
      lobby: {
        host: { id: 'host' },
        guest: { id: 'guest', name: 'Guest', deckName: 'Deck', ready: true },
      },
    }

    expect(snapshotToCloudRoom(value).players).toEqual([
      { id: 'guest', name: 'Guest', deckName: 'Deck', ready: true },
    ])
  })
})
