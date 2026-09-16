import { describe, expect, it } from 'vitest'
import { applyRemoteMatchAction } from './matchRules.js'

const card = (uid, kind, rules = '') => ({ uid, id: uid, name: uid, image: '', kind, cost: 1, rules, tapped: false })
const player = (index, hand = []) => ({ id: `${index}`, name: `Player ${index}`, life: 20, hand, library: [], battlefield: [], graveyard: [], index, landsPlayedThisTurn: 0 })
const game = (firstHand = [], secondHand = []) => ({
  turn: 1, activePlayer: 0, priorityPlayer: 0, consecutivePasses: 0, phase: 'main1', stack: [],
  players: [player(0, firstHand), player(1, secondHand)], log: [],
})

describe('remote match reducer', () => {
  it('keeps prior snapshots immutable and resolves responses FILO', () => {
    const initial = game([card('bolt', 'instant', 'Bolt deals 3 damage to any target.')], [card('shock', 'instant', 'Shock deals 2 damage to any target.')])
    const bolt = applyRemoteMatchAction(initial, 0, 'play', { uid: 'bolt' })
    const givePriority = applyRemoteMatchAction(bolt.state, 0, 'pass')
    const shock = applyRemoteMatchAction(givePriority.state, 1, 'play', { uid: 'shock' })
    const passOne = applyRemoteMatchAction(shock.state, 1, 'pass')
    const resolveShock = applyRemoteMatchAction(passOne.state, 0, 'pass')

    expect(initial.players[0].hand).toHaveLength(1)
    expect(resolveShock.state.stack.map((item) => item.card.uid)).toEqual(['bolt'])
    expect(resolveShock.state.players[0].life).toBe(18)
    expect(resolveShock.state.players[1].life).toBe(20)
  })

  it('enforces one land per turn and advances only after all players pass', () => {
    const initial = game([card('land-a', 'land'), card('land-b', 'land')])
    const firstLand = applyRemoteMatchAction(initial, 0, 'play', { uid: 'land-a' })
    expect(applyRemoteMatchAction(firstLand.state, 0, 'play', { uid: 'land-b' }).accepted).toBe(false)

    const onePass = applyRemoteMatchAction(firstLand.state, 0, 'pass')
    const allPass = applyRemoteMatchAction(onePass.state, 1, 'pass')
    expect(onePass.state.phase).toBe('main1')
    expect(allPass.state.phase).toBe('begin_combat')
  })
})
