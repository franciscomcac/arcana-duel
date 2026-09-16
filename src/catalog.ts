export type CatalogCardKind =
  | 'land'
  | 'creature'
  | 'instant'
  | 'sorcery'
  | 'artifact'
  | 'enchantment'
  | 'planeswalker'
  | 'battle'

export type CatalogCard = {
  id: string
  oracleId?: string
  name: string
  image: string
  color: 'white' | 'blue' | 'black' | 'green' | 'red' | 'gold' | 'colorless'
  kind: CatalogCardKind
  cost: number
  mana: string
  typeLine: string
  rules: string
  rarity: 'Common' | 'Uncommon' | 'Rare' | 'Mythic'
  setCode?: string
  collectorNumber?: string
  legalities?: Record<string, 'legal' | 'not_legal' | 'restricted' | 'banned'>
  power?: number
  toughness?: number
}

export const catalog: CatalogCard[] = [
  { id: 'forest', name: 'Forest', image: '/cards/forest.jpg', color: 'green', kind: 'land', cost: 0, mana: 'G', typeLine: 'Basic Land - Forest', rules: '{T}: Add {G}.', rarity: 'Common' },
  { id: 'mountain', name: 'Mountain', image: '/cards/mountain.jpg', color: 'red', kind: 'land', cost: 0, mana: 'R', typeLine: 'Basic Land - Mountain', rules: '{T}: Add {R}.', rarity: 'Common' },
  { id: 'rockfall-vale', name: 'Rockfall Vale', image: '/cards/rockfall-vale.jpg', color: 'gold', kind: 'land', cost: 0, mana: 'RG', typeLine: 'Land', rules: '{T}: Add {R} or {G}.', rarity: 'Rare' },
  { id: 'llanowar-elves', name: 'Llanowar Elves', image: '/cards/llanowar-elves.jpg', color: 'green', kind: 'creature', cost: 1, mana: 'G', typeLine: 'Creature - Elf Druid', rules: '{T}: Add {G}.', rarity: 'Common', power: 1, toughness: 1 },
  { id: 'elvish-mystic', name: 'Elvish Mystic', image: '/cards/elvish-mystic.jpg', color: 'green', kind: 'creature', cost: 1, mana: 'G', typeLine: 'Creature - Elf Druid', rules: '{T}: Add {G}.', rarity: 'Common', power: 1, toughness: 1 },
  { id: 'kird-ape', name: 'Kird Ape', image: '/cards/kird-ape.jpg', color: 'red', kind: 'creature', cost: 1, mana: 'R', typeLine: 'Creature - Ape', rules: 'Gets +1/+2 as long as you control a Forest.', rarity: 'Uncommon', power: 1, toughness: 1 },
  { id: 'grizzly-bears', name: 'Grizzly Bears', image: '/cards/grizzly-bears.jpg', color: 'green', kind: 'creature', cost: 2, mana: '1G', typeLine: 'Creature - Bear', rules: '', rarity: 'Common', power: 2, toughness: 2 },
  { id: 'kessig-naturalist', name: 'Kessig Naturalist', image: '/cards/kessig-naturalist.jpg', color: 'gold', kind: 'creature', cost: 2, mana: 'RG', typeLine: 'Creature - Human Werewolf', rules: 'Whenever this attacks, add {R} or {G}.', rarity: 'Uncommon', power: 2, toughness: 2 },
  { id: 'reclamation-sage', name: 'Reclamation Sage', image: '/cards/reclamation-sage.jpg', color: 'green', kind: 'creature', cost: 3, mana: '2G', typeLine: 'Creature - Elf Shaman', rules: 'When this enters, destroy target artifact or enchantment.', rarity: 'Uncommon', power: 2, toughness: 1 },
  { id: 'questing-beast', name: 'Questing Beast', image: '/cards/questing-beast.jpg', color: 'green', kind: 'creature', cost: 4, mana: '2GG', typeLine: 'Legendary Creature - Beast', rules: 'Vigilance, deathtouch, haste.', rarity: 'Mythic', power: 4, toughness: 4 },
  { id: 'lightning-bolt', name: 'Lightning Bolt', image: '/cards/lightning-bolt.jpg', color: 'red', kind: 'instant', cost: 1, mana: 'R', typeLine: 'Instant', rules: 'Deals 3 damage to any target.', rarity: 'Uncommon' },
  { id: 'shock', name: 'Shock', image: '/cards/shock.jpg', color: 'red', kind: 'instant', cost: 1, mana: 'R', typeLine: 'Instant', rules: 'Deals 2 damage to any target.', rarity: 'Common' },
  { id: 'giant-growth', name: 'Giant Growth', image: '/cards/giant-growth.jpg', color: 'green', kind: 'instant', cost: 1, mana: 'G', typeLine: 'Instant', rules: 'Target creature gets +3/+3 until end of turn.', rarity: 'Common' },
  { id: 'embercleave', name: 'Embercleave', image: '/cards/embercleave.jpg', color: 'red', kind: 'artifact', cost: 6, mana: '4RR', typeLine: 'Legendary Artifact - Equipment', rules: 'Flash. Equipped creature gets +1/+1 and has double strike and trample.', rarity: 'Mythic' },
]

export type DeckEntry = { cardId: string; quantity: number; card?: CatalogCard }
export type SavedDeck = {
  id: string
  name: string
  format: string
  updatedAt: number
  entries: DeckEntry[]
  sideboard: DeckEntry[]
}

const CARD_KINDS = new Set<CatalogCardKind>(['land', 'creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'battle'])
const CARD_COLORS = new Set<CatalogCard['color']>(['white', 'blue', 'black', 'green', 'red', 'gold', 'colorless'])
const CARD_RARITIES = new Set<CatalogCard['rarity']>(['Common', 'Uncommon', 'Rare', 'Mythic'])

export function isCatalogCard(value: unknown): value is CatalogCard {
  if (!value || typeof value !== 'object') return false
  const card = value as Partial<CatalogCard>
  return typeof card.id === 'string'
    && card.id.length > 0
    && typeof card.name === 'string'
    && typeof card.image === 'string'
    && CARD_COLORS.has(card.color as CatalogCard['color'])
    && CARD_KINDS.has(card.kind as CatalogCardKind)
    && Number.isFinite(card.cost)
    && typeof card.mana === 'string'
    && typeof card.typeLine === 'string'
    && typeof card.rules === 'string'
    && CARD_RARITIES.has(card.rarity as CatalogCard['rarity'])
}

export function sanitizeDeckEntries(value: unknown): DeckEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Partial<DeckEntry>
    if (typeof entry.cardId !== 'string' || !entry.cardId || !Number.isInteger(entry.quantity) || Number(entry.quantity) < 1 || Number(entry.quantity) > 999) return []
    return [{ cardId: entry.cardId, quantity: Number(entry.quantity), card: isCatalogCard(entry.card) ? { ...entry.card } : undefined }]
  })
}

export function normalizeSavedDecks(value: unknown): SavedDeck[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const deck = item as Partial<SavedDeck>
    if (typeof deck.id !== 'string' || !deck.id || seen.has(deck.id) || typeof deck.name !== 'string' || typeof deck.format !== 'string') return []
    seen.add(deck.id)
    return [{
      id: deck.id.slice(0, 160),
      name: deck.name.slice(0, 80) || 'Untitled Deck',
      format: deck.format.slice(0, 32) || 'Standard',
      updatedAt: Number.isFinite(deck.updatedAt) && Number(deck.updatedAt) > 0 ? Number(deck.updatedAt) : Date.now(),
      entries: sanitizeDeckEntries(deck.entries),
      sideboard: sanitizeDeckEntries(deck.sideboard),
    }]
  })
}

const starterEntries: DeckEntry[] = [
  // Keep the out-of-box list tournament-shaped so it can be queued immediately.
  { cardId: 'forest', quantity: 15 }, { cardId: 'mountain', quantity: 13 }, { cardId: 'rockfall-vale', quantity: 2 },
  { cardId: 'llanowar-elves', quantity: 4 }, { cardId: 'elvish-mystic', quantity: 4 }, { cardId: 'kird-ape', quantity: 4 },
  { cardId: 'grizzly-bears', quantity: 4 }, { cardId: 'kessig-naturalist', quantity: 4 }, { cardId: 'reclamation-sage', quantity: 4 },
  { cardId: 'questing-beast', quantity: 2 }, { cardId: 'lightning-bolt', quantity: 4 }, { cardId: 'giant-growth', quantity: 4 }, { cardId: 'shock', quantity: 2 },
]

export const starterDeck = (): SavedDeck => ({
  id: 'starter-gruul',
  name: 'Wildfire Stompy',
  format: 'Standard',
  updatedAt: Date.now(),
  entries: starterEntries,
  sideboard: [{ cardId: 'embercleave', quantity: 2 }, { cardId: 'reclamation-sage', quantity: 2 }],
})

export const botDeck = (): SavedDeck => ({
  id: 'bot-rush',
  name: 'VEX_MAGE · Ember Rush',
  format: 'Standard',
  updatedAt: Date.now(),
  entries: [
    { cardId: 'mountain', quantity: 24 }, { cardId: 'kird-ape', quantity: 4 },
    { cardId: 'grizzly-bears', quantity: 4 }, { cardId: 'lightning-bolt', quantity: 4 },
    { cardId: 'shock', quantity: 4 }, { cardId: 'embercleave', quantity: 2 },
    { cardId: 'questing-beast', quantity: 2 }, { cardId: 'reclamation-sage', quantity: 4 },
    { cardId: 'llanowar-elves', quantity: 4 }, { cardId: 'giant-growth', quantity: 4 },
  ],
  sideboard: [],
})

export const expandDeck = (deck: SavedDeck) => deck.entries.flatMap((entry) => Array(entry.quantity).fill(entry.cardId))

export const resolveDeckCard = (entry: DeckEntry) => entry.card || catalog.find((card) => card.id === entry.cardId)

export const expandDeckCards = (deck: SavedDeck) => deck.entries.flatMap((entry) => {
  const card = resolveDeckCard(entry)
  return card ? Array.from({ length: entry.quantity }, () => card) : []
})

export function loadDecks(): SavedDeck[] {
  try {
    const saved = localStorage.getItem('arcana.saved-decks')
    if (!saved) return [starterDeck()]
    const decks = normalizeSavedDecks(JSON.parse(saved))
    return decks.length ? decks : [starterDeck()]
  } catch { return [starterDeck()] }
}

export function persistDecks(decks: SavedDeck[]) {
  localStorage.setItem('arcana.saved-decks', JSON.stringify(decks))
}
