import { describe, expect, it } from 'vitest'
import type { CardData } from '../types'
import { isHandSortMode, sortHand } from './handSorting'

function card(overrides: Partial<CardData> & Pick<CardData, 'uid' | 'name'>): CardData {
  return {
    oracleName: overrides.name,
    kind: 'creature',
    color: 'green',
    cost: 2,
    typeLine: 'Creature',
    rules: '',
    image: '/card.jpg',
    ...overrides,
  }
}

const hand = [
  card({ uid: 'bolt', name: 'Lightning Bolt', kind: 'instant', color: 'red', cost: 1 }),
  card({ uid: 'forest', name: 'Forest', kind: 'land', color: 'green', cost: 0 }),
  card({ uid: 'beast', name: 'Questing Beast', color: 'green', cost: 4 }),
  card({ uid: 'mystic', name: 'Elvish Mystic', color: 'green', cost: 1 }),
]

describe('sortHand', () => {
  it('orders by mana value without mutating engine hand order', () => {
    const original = hand.map((item) => item.uid)
    expect(sortHand(hand, 'mana').map((item) => item.uid)).toEqual(['forest', 'mystic', 'bolt', 'beast'])
    expect(hand.map((item) => item.uid)).toEqual(original)
  })

  it('supports type, color, and name views', () => {
    expect(sortHand(hand, 'type').map((item) => item.uid)).toEqual(['forest', 'mystic', 'beast', 'bolt'])
    expect(sortHand(hand, 'color').map((item) => item.uid)).toEqual(['bolt', 'forest', 'mystic', 'beast'])
    expect(sortHand(hand, 'name').map((item) => item.uid)).toEqual(['mystic', 'forest', 'bolt', 'beast'])
  })

  it('validates persisted sort preferences', () => {
    expect(isHandSortMode('mana')).toBe(true)
    expect(isHandSortMode('rarity')).toBe(false)
    expect(isHandSortMode(null)).toBe(false)
  })
})
