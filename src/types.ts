export type CardKind = 'land' | 'creature' | 'instant' | 'sorcery' | 'artifact' | 'enchantment' | 'planeswalker' | 'battle'

export type CardColor = 'white' | 'blue' | 'black' | 'red' | 'green' | 'gold' | 'colorless'

export interface CardData {
  uid: string
  oracleName: string
  name: string
  kind: CardKind
  color: CardColor
  cost: number
  mana?: string
  typeLine: string
  rules: string
  flavor?: string
  power?: number
  toughness?: number
  image: string
  tapped?: boolean
  attacking?: boolean
  summoningSick?: boolean
  buff?: number
}

export type Phase = 'untap' | 'draw' | 'main' | 'combat' | 'second' | 'end'

export interface GameLogItem {
  id: number
  text: string
  tone?: 'default' | 'damage' | 'spell'
}
