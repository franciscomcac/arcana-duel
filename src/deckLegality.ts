import { resolveDeckCard, type DeckEntry, type SavedDeck } from './catalog'

export const SUPPORTED_FORMATS = [
  'Standard', 'Pioneer', 'Modern', 'Legacy', 'Vintage',
  'Pauper', 'Commander', 'Brawl', 'Historic', 'Timeless',
] as const

type FormatRule = {
  scryfallKey: string
  minimum: number
  maximum?: number
  singleton?: boolean
  sideboardMaximum: number
}

const FORMAT_RULES: Record<string, FormatRule> = {
  standard: { scryfallKey: 'standard', minimum: 60, sideboardMaximum: 15 },
  pioneer: { scryfallKey: 'pioneer', minimum: 60, sideboardMaximum: 15 },
  modern: { scryfallKey: 'modern', minimum: 60, sideboardMaximum: 15 },
  legacy: { scryfallKey: 'legacy', minimum: 60, sideboardMaximum: 15 },
  vintage: { scryfallKey: 'vintage', minimum: 60, sideboardMaximum: 15 },
  pauper: { scryfallKey: 'pauper', minimum: 60, sideboardMaximum: 15 },
  commander: { scryfallKey: 'commander', minimum: 100, maximum: 100, singleton: true, sideboardMaximum: 0 },
  brawl: { scryfallKey: 'brawl', minimum: 60, maximum: 60, singleton: true, sideboardMaximum: 0 },
  historic: { scryfallKey: 'historic', minimum: 60, sideboardMaximum: 15 },
  timeless: { scryfallKey: 'timeless', minimum: 60, sideboardMaximum: 15 },
}

export type DeckLegalityIssue = {
  code: 'minimum' | 'maximum' | 'sideboard' | 'copies' | 'banned'
  message: string
  cardName?: string
}

export type DeckLegality = {
  legal: boolean
  minimum: number
  maximum?: number
  sideboardMaximum: number
  mainboardCount: number
  sideboardCount: number
  issues: DeckLegalityIssue[]
}

const countCards = (entries: DeckEntry[]) => entries.reduce((total, entry) => total + entry.quantity, 0)

export function evaluateDeckLegality(deck: SavedDeck): DeckLegality {
  const rule = FORMAT_RULES[deck.format.toLocaleLowerCase()] ?? FORMAT_RULES.standard
  const mainboardCount = countCards(deck.entries)
  const sideboardCount = countCards(deck.sideboard)
  const issues: DeckLegalityIssue[] = []

  if (mainboardCount < rule.minimum) issues.push({ code: 'minimum', message: `${rule.minimum - mainboardCount} cards needed` })
  if (rule.maximum !== undefined && mainboardCount > rule.maximum) issues.push({ code: 'maximum', message: `${mainboardCount - rule.maximum} cards over the format limit` })
  if (sideboardCount > rule.sideboardMaximum) issues.push({ code: 'sideboard', message: `${sideboardCount - rule.sideboardMaximum} too many sideboard cards` })

  const copies = new Map<string, { name: string; quantity: number; basic: boolean }>()
  for (const entry of [...deck.entries, ...deck.sideboard]) {
    const card = resolveDeckCard(entry)
    if (!card) continue
    const key = card.oracleId || card.name.toLocaleLowerCase()
    const current = copies.get(key)
    copies.set(key, {
      name: card.name,
      quantity: (current?.quantity ?? 0) + entry.quantity,
      basic: Boolean(current?.basic) || /\bbasic\b/i.test(card.typeLine),
    })

    const legality = card.legalities?.[rule.scryfallKey]
    if ((legality === 'not_legal' || legality === 'banned') && !issues.some((issue) => issue.code === 'banned' && issue.cardName === card.name)) {
      issues.push({ code: 'banned', cardName: card.name, message: `${card.name} is not legal in ${deck.format}` })
    }
  }

  for (const card of copies.values()) {
    const limit = rule.singleton ? 1 : 4
    if (!card.basic && card.quantity > limit) {
      issues.push({ code: 'copies', cardName: card.name, message: `${card.name} has ${card.quantity} copies; ${deck.format} allows ${limit}` })
    }
  }

  return { legal: issues.length === 0, minimum: rule.minimum, maximum: rule.maximum, sideboardMaximum: rule.sideboardMaximum, mainboardCount, sideboardCount, issues }
}
