import type { CardData } from './types'

const cardImage = (name: string) =>
  `/cards/${name.toLowerCase().replaceAll(' ', '-')}.jpg`

let seed = 0
const id = (prefix: string) => `${prefix}-${++seed}`

export const makeCard = (oracleName: string, overrides: Partial<CardData> = {}): CardData => ({
  uid: id(oracleName.toLowerCase().replaceAll(' ', '-')),
  oracleName,
  name: oracleName,
  kind: 'creature',
  color: 'green',
  cost: 2,
  typeLine: 'Creature',
  rules: '',
  image: cardImage(oracleName),
  ...overrides,
})

export const initialHand = () => [
  makeCard('Forest', { kind: 'land', color: 'green', cost: 0, typeLine: 'Basic Land - Forest', rules: '{T}: Add {G}.' }),
  makeCard('Mountain', { kind: 'land', color: 'red', cost: 0, typeLine: 'Basic Land - Mountain', rules: '{T}: Add {R}.' }),
  makeCard('Llanowar Elves', { cost: 1, mana: 'G', typeLine: 'Creature - Elf Druid', rules: '{T}: Add {G}.', power: 1, toughness: 1 }),
  makeCard('Kessig Naturalist', { color: 'gold', cost: 2, mana: 'RG', typeLine: 'Creature - Human Werewolf', rules: 'Whenever Kessig Naturalist attacks, add {R} or {G}.', power: 2, toughness: 2 }),
  makeCard('Lightning Bolt', { kind: 'instant', color: 'red', cost: 1, mana: 'R', typeLine: 'Instant', rules: 'Lightning Bolt deals 3 damage to any target.' }),
  makeCard('Giant Growth', { kind: 'instant', color: 'green', cost: 1, mana: 'G', typeLine: 'Instant', rules: 'Target creature gets +3/+3 until end of turn.' }),
  makeCard('Rockfall Vale', { kind: 'land', color: 'gold', cost: 0, typeLine: 'Land', rules: '{T}: Add {R} or {G}.' }),
]

export const initialPlayerBoard = () => [
  makeCard('Forest', { kind: 'land', color: 'green', cost: 0, typeLine: 'Basic Land - Forest', rules: '{T}: Add {G}.' }),
  makeCard('Forest', { kind: 'land', color: 'green', cost: 0, typeLine: 'Basic Land - Forest', rules: '{T}: Add {G}.' }),
  makeCard('Mountain', { kind: 'land', color: 'red', cost: 0, typeLine: 'Basic Land - Mountain', rules: '{T}: Add {R}.' }),
  makeCard('Mountain', { kind: 'land', color: 'red', cost: 0, typeLine: 'Basic Land - Mountain', rules: '{T}: Add {R}.' }),
  makeCard('Elvish Mystic', { cost: 1, mana: 'G', typeLine: 'Creature - Elf Druid', rules: '{T}: Add {G}.', power: 1, toughness: 1 }),
  makeCard('Reclamation Sage', { cost: 3, mana: '2G', typeLine: 'Creature - Elf Shaman', rules: 'When this enters, destroy target artifact or enchantment.', power: 2, toughness: 1 }),
]

export const initialOpponentBoard = () => [
  makeCard('Mountain', { kind: 'land', color: 'red', cost: 0, typeLine: 'Basic Land - Mountain', rules: '{T}: Add {R}.', tapped: true }),
  makeCard('Mountain', { kind: 'land', color: 'red', cost: 0, typeLine: 'Basic Land - Mountain', rules: '{T}: Add {R}.' }),
  makeCard('Forest', { kind: 'land', color: 'green', cost: 0, typeLine: 'Basic Land - Forest', rules: '{T}: Add {G}.' }),
  makeCard('Grizzly Bears', { cost: 2, mana: '1G', typeLine: 'Creature - Bear', rules: '', power: 2, toughness: 2 }),
  makeCard('Kird Ape', { color: 'red', cost: 1, mana: 'R', typeLine: 'Creature - Ape', rules: 'Kird Ape gets +1/+2 as long as you control a Forest.', power: 1, toughness: 1 }),
]

export const drawPile = () => [
  makeCard('Questing Beast', { cost: 4, mana: '2GG', typeLine: 'Legendary Creature - Beast', rules: 'Vigilance, deathtouch, haste', power: 4, toughness: 4 }),
  makeCard('Shock', { kind: 'instant', color: 'red', cost: 1, mana: 'R', typeLine: 'Instant', rules: 'Shock deals 2 damage to any target.' }),
  makeCard('Llanowar Elves', { cost: 1, mana: 'G', typeLine: 'Creature - Elf Druid', rules: '{T}: Add {G}.', power: 1, toughness: 1 }),
  makeCard('Forest', { kind: 'land', color: 'green', cost: 0, typeLine: 'Basic Land - Forest', rules: '{T}: Add {G}.' }),
]

export const phases: { id: import('./types').Phase; label: string }[] = [
  { id: 'untap', label: 'Untap' },
  { id: 'draw', label: 'Draw' },
  { id: 'main', label: 'Main' },
  { id: 'combat', label: 'Combat' },
  { id: 'second', label: 'Main' },
  { id: 'end', label: 'End' },
]
