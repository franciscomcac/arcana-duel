import { describe, expect, it } from 'vitest'
import type { CatalogCard, SavedDeck } from './catalog'
import { evaluateDeckLegality } from './deckLegality'

const card = (name: string, options: Partial<CatalogCard> = {}): CatalogCard => ({
  id: name.toLocaleLowerCase().replaceAll(' ', '-'), name, image: '', color: 'colorless',
  kind: 'artifact', cost: 1, mana: '1', typeLine: 'Artifact', rules: '', rarity: 'Rare', ...options,
})

const deck = (format: string, entries: SavedDeck['entries'], sideboard: SavedDeck['sideboard'] = []): SavedDeck => ({
  id: 'deck', name: 'Deck', format, updatedAt: 1, entries, sideboard,
})

describe('deck legality', () => {
  it('combines different printings when enforcing copy limits', () => {
    const first = card('Lightning Bolt', { id: 'printing-a', oracleId: 'bolt' })
    const second = card('Lightning Bolt', { id: 'printing-b', oracleId: 'bolt' })
    const result = evaluateDeckLegality(deck('Modern', [
      { cardId: first.id, quantity: 3, card: first }, { cardId: second.id, quantity: 2, card: second }, { cardId: 'forest', quantity: 55 },
    ]))
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'copies', cardName: 'Lightning Bolt' })]))
  })

  it('allows any number of basic lands in singleton formats', () => {
    const result = evaluateDeckLegality(deck('Commander', [
      { cardId: 'forest', quantity: 99 }, { cardId: 'commander', quantity: 1, card: card('Commander') },
    ]))
    expect(result.legal).toBe(true)
  })

  it('uses Scryfall legality when metadata is available', () => {
    const banned = card('Banned Card', { legalities: { standard: 'banned' } })
    const result = evaluateDeckLegality(deck('Standard', [{ cardId: 'forest', quantity: 59 }, { cardId: banned.id, quantity: 1, card: banned }]))
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'banned' })]))
  })
})
