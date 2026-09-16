import { describe, expect, it } from 'vitest'
import type { CardData } from '../types'
import { planBotTurn } from './practiceBot'

const card = (uid: string, overrides: Partial<CardData>): CardData => ({
  uid,
  oracleName: uid,
  name: uid,
  kind: 'creature',
  color: 'red',
  cost: 1,
  typeLine: 'Creature',
  rules: '',
  image: '',
  power: 1,
  toughness: 1,
  ...overrides,
})

describe('planBotTurn', () => {
  it('points lethal burn at the opposing player', () => {
    const bolt = card('bolt', { kind: 'instant', rules: 'Lightning Bolt deals 3 damage to any target.', power: undefined, toughness: undefined })
    const plan = planBotTurn({ hand: [bolt], battlefield: [card('mountain', { kind: 'land' })], opposingBattlefield: [], opposingLife: 3 })
    expect(plan.spellId).toBe('bolt')
    expect(plan.spellTarget).toEqual({ kind: 'player' })
  })

  it('holds back a creature that would die without trading', () => {
    const attacker = card('attacker', { power: 2, toughness: 2, summoningSick: false })
    const blocker = card('blocker', { power: 3, toughness: 4 })
    const plan = planBotTurn({ hand: [], battlefield: [attacker], opposingBattlefield: [blocker], opposingLife: 20 })
    expect(plan.attackerIds).toEqual([])
  })
})
