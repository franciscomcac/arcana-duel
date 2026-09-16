import { describe, expect, it } from 'vitest'
import { normalizeSavedDecks, sanitizeDeckEntries } from './catalog'

describe('saved deck normalization', () => {
  it('drops malformed entries while retaining valid embedded cards', () => {
    const entries = sanitizeDeckEntries([
      { cardId: 'forest', quantity: 4 },
      { cardId: 'bad', quantity: -2 },
      { cardId: 'custom', quantity: 1, card: {
        id: 'custom', name: 'Custom', image: '/custom.jpg', color: 'blue', kind: 'sorcery',
        cost: 2, mana: '1U', typeLine: 'Sorcery', rules: 'Draw a card.', rarity: 'Common',
      } },
      { cardId: 'broken-card', quantity: 1, card: { name: 'Missing fields' } },
    ])

    expect(entries).toHaveLength(3)
    expect(entries[1].card?.name).toBe('Custom')
    expect(entries[2].card).toBeUndefined()
  })

  it('rejects invalid and duplicate deck records', () => {
    const decks = normalizeSavedDecks([
      { id: 'one', name: 'Valid', format: 'Modern', updatedAt: 10, entries: [], sideboard: [] },
      { id: 'one', name: 'Duplicate', format: 'Modern', entries: [], sideboard: [] },
      { name: 'No ID', format: 'Modern' },
    ])

    expect(decks).toEqual([expect.objectContaining({ id: 'one', name: 'Valid', format: 'Modern' })])
  })
})
