import type { CardData } from '../types'

export type HandSortMode = 'mana' | 'type' | 'color' | 'name'

export const HAND_SORT_OPTIONS: ReadonlyArray<{ value: HandSortMode; label: string }> = [
  { value: 'mana', label: 'Mana value' },
  { value: 'type', label: 'Card type' },
  { value: 'color', label: 'Color' },
  { value: 'name', label: 'Name' },
]

const TYPE_ORDER: Record<CardData['kind'], number> = {
  land: 0,
  creature: 1,
  planeswalker: 2,
  artifact: 3,
  enchantment: 4,
  battle: 5,
  instant: 6,
  sorcery: 7,
}

const COLOR_ORDER: Record<CardData['color'], number> = {
  white: 0,
  blue: 1,
  black: 2,
  red: 3,
  green: 4,
  gold: 5,
  colorless: 6,
}

export function isHandSortMode(value: string | null): value is HandSortMode {
  return HAND_SORT_OPTIONS.some((option) => option.value === value)
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

function compareMana(left: CardData, right: CardData): number {
  return left.cost - right.cost
    || TYPE_ORDER[left.kind] - TYPE_ORDER[right.kind]
    || COLOR_ORDER[left.color] - COLOR_ORDER[right.color]
    || compareText(left.name, right.name)
}

function compareType(left: CardData, right: CardData): number {
  return TYPE_ORDER[left.kind] - TYPE_ORDER[right.kind]
    || left.cost - right.cost
    || COLOR_ORDER[left.color] - COLOR_ORDER[right.color]
    || compareText(left.name, right.name)
}

function compareColor(left: CardData, right: CardData): number {
  return COLOR_ORDER[left.color] - COLOR_ORDER[right.color]
    || left.cost - right.cost
    || TYPE_ORDER[left.kind] - TYPE_ORDER[right.kind]
    || compareText(left.name, right.name)
}

export function sortHand(cards: readonly CardData[], mode: HandSortMode): CardData[] {
  return [...cards].sort((left, right) => {
    if (mode === 'name') return compareText(left.name, right.name) || compareMana(left, right)
    if (mode === 'type') return compareType(left, right)
    if (mode === 'color') return compareColor(left, right)
    return compareMana(left, right)
  })
}
