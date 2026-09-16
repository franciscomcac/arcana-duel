import { describe, expect, it } from 'vitest'
import type { SavedDeck } from '../catalog'
import { mergeDeckCollections } from './deckRepository'

const deck = (id: string, updatedAt: number, name: string): SavedDeck => ({
  id,
  updatedAt,
  name,
  format: 'Standard',
  entries: [],
  sideboard: [],
})

describe('mergeDeckCollections', () => {
  it('keeps the newest revision for a shared client key', () => {
    const result = mergeDeckCollections(
      [deck('shared', 100, 'Local old')],
      [deck('shared', 200, 'Cloud new')],
    )
    expect(result).toEqual([expect.objectContaining({ id: 'shared', name: 'Cloud new' })])
  })

  it('preserves unique local and cloud decks in newest-first order', () => {
    const result = mergeDeckCollections(
      [deck('local', 100, 'Local')],
      [deck('cloud', 300, 'Cloud')],
    )
    expect(result.map((item) => item.id)).toEqual(['cloud', 'local'])
  })
})
