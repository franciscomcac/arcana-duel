import type { CardData } from '../types'

export type BotTarget =
  | { kind: 'player' }
  | { kind: 'creature'; cardId: string }

export type BotPlan = {
  landId?: string
  spellId?: string
  spellTarget?: BotTarget
  attackerIds: string[]
  blocks: Record<string, string>
}

type BotPosition = {
  hand: CardData[]
  battlefield: CardData[]
  opposingBattlefield: CardData[]
  opposingAttackers?: CardData[]
  opposingLife: number
}

function cardValue(card: CardData) {
  const combat = (card.power ?? 0) + (card.toughness ?? 0)
  const keywordBonus = /flying|deathtouch|double strike|trample|haste/i.test(card.rules) ? 2 : 0
  return combat + keywordBonus - card.cost * 0.15
}

function isDamageSpell(card: CardData) {
  return card.kind === 'instant' && /deal[s]?\s+\d+\s+damage/i.test(card.rules)
}

function damageAmount(card: CardData) {
  const match = card.rules.match(/deal[s]?\s+(\d+)\s+damage/i)
  return match ? Number(match[1]) : 0
}

export function planBotTurn(position: BotPosition): BotPlan {
  const land = position.hand.find((card) => card.kind === 'land')
  const manaAfterLand = position.battlefield.filter((card) => card.kind === 'land').length + (land ? 1 : 0)
  const castable = position.hand.filter((card) => card.uid !== land?.uid && card.kind !== 'land' && card.cost <= manaAfterLand)

  const lethalBurn = castable
    .filter(isDamageSpell)
    .find((card) => damageAmount(card) >= position.opposingLife)
  const permanent = castable
    .filter((card) => card.kind === 'creature' || card.kind === 'artifact')
    .sort((a, b) => cardValue(b) - cardValue(a))[0]
  const removal = castable
    .filter(isDamageSpell)
    .sort((a, b) => damageAmount(b) - damageAmount(a))[0]
  const spell = lethalBurn ?? permanent ?? removal ?? castable.sort((a, b) => cardValue(b) - cardValue(a))[0]

  let spellTarget: BotTarget | undefined
  if (spell && isDamageSpell(spell)) {
    const damage = damageAmount(spell)
    const killable = position.opposingBattlefield
      .filter((card) => card.kind === 'creature' && (card.toughness ?? Number.POSITIVE_INFINITY) <= damage)
      .sort((a, b) => cardValue(b) - cardValue(a))[0]
    spellTarget = lethalBurn || !killable ? { kind: 'player' } : { kind: 'creature', cardId: killable.uid }
  }

  const attackers = position.battlefield.filter((card) => {
    if (card.kind !== 'creature' || card.tapped || card.summoningSick) return false
    if (/defender/i.test(card.rules)) return false
    return true
  })
  const availableBlockers = position.opposingBattlefield.filter((card) => card.kind === 'creature' && !card.tapped)
  const safeAttackers = attackers.filter((attacker) => {
    if (/flying/i.test(attacker.rules) && !availableBlockers.some((blocker) => /flying|reach/i.test(blocker.rules))) return true
    return !availableBlockers.some((blocker) => (blocker.power ?? 0) >= (attacker.toughness ?? 0) && (blocker.toughness ?? 0) > (attacker.power ?? 0))
  })

  const blocks: Record<string, string> = {}
  const unusedBlockers = position.battlefield
    .filter((card) => card.kind === 'creature' && !card.tapped)
    .sort((a, b) => cardValue(a) - cardValue(b))
  for (const attacker of [...(position.opposingAttackers ?? [])].sort((a, b) => (b.power ?? 0) - (a.power ?? 0))) {
    const blockerIndex = unusedBlockers.findIndex((blocker) => {
      const canReach = !/flying/i.test(attacker.rules) || /flying|reach/i.test(blocker.rules)
      return canReach && (blocker.power ?? 0) >= (attacker.toughness ?? 0)
    })
    if (blockerIndex >= 0) {
      blocks[attacker.uid] = unusedBlockers[blockerIndex].uid
      unusedBlockers.splice(blockerIndex, 1)
    }
  }

  return {
    landId: land?.uid,
    spellId: spell?.uid,
    spellTarget,
    attackerIds: safeAttackers.map((card) => card.uid),
    blocks,
  }
}
