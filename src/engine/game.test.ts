import { describe, expect, it } from 'vitest'
import { chooseBlocks, chooseBotAction } from './bot'
import { checkAction, createGame, gameReducer, getPower, getToughness, hasKeyword, reduceActions, runStateBasedActions } from './game'
import type { CardDefinition, GameState } from './types'

const forest: CardDefinition = {
  id: 'forest',
  name: 'Forest',
  types: ['land'],
  producesMana: { G: 1 },
}

const bear: CardDefinition = {
  id: 'bear',
  name: 'Rune Bear',
  types: ['creature'],
  manaCost: '{1}{G}',
  manaValue: 2,
  power: 2,
  toughness: 2,
}

function gameWithDecks(firstDeck: CardDefinition[], secondDeck: CardDefinition[], openingHandSize = 0): GameState {
  return createGame({
    players: [
      { id: 'a', name: 'Ari', deck: firstDeck },
      { id: 'b', name: 'Bea', deck: secondDeck },
    ],
    openingHandSize,
    skipFirstDraw: true,
  })
}

describe('immutable game reducer', () => {
  it('resolves spells in strict FILO order without mutating prior states', () => {
    const ping: CardDefinition = {
      id: 'ping',
      name: 'Ping',
      types: ['instant'],
      effects: [{ type: 'damage', amount: 2, target: { kind: 'target-slot', index: 0 } }],
    }
    const bolt: CardDefinition = {
      id: 'bolt',
      name: 'Bolt',
      types: ['instant'],
      effects: [{ type: 'damage', amount: 3, target: { kind: 'target-slot', index: 0 } }],
    }
    const initial = gameWithDecks([ping, bolt], [forest, forest], 2)
    const pingId = initial.players.a.zones.hand[0]
    const boltId = initial.players.a.zones.hand[1]
    const cast = reduceActions(initial, [
      { type: 'CAST_SPELL', playerId: 'a', cardId: pingId, targets: [{ kind: 'player', playerId: 'b' }] },
      { type: 'CAST_SPELL', playerId: 'a', cardId: boltId, targets: [{ kind: 'player', playerId: 'b' }] },
    ])

    expect(cast.accepted).toBe(true)
    expect(initial.players.a.zones.hand).toHaveLength(2)
    expect(cast.state.stack.map((item) => item.name)).toEqual(['Ping', 'Bolt'])

    const firstResolution = reduceActions(cast.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(firstResolution.state.players.b.life).toBe(17)
    expect(firstResolution.state.stack.map((item) => item.name)).toEqual(['Ping'])

    const secondResolution = reduceActions(firstResolution.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(secondResolution.state.players.b.life).toBe(15)
    expect(secondResolution.state.stack).toHaveLength(0)
    expect(secondResolution.state.players.a.zones.graveyard).toEqual([boltId, pingId])
  })

  it('requires declarations and applies simultaneous combat damage', () => {
    const state = gameWithDecks([bear], [bear])
    const attackerId = state.players.a.zones.library[0]
    const blockerId = state.players.b.zones.library[0]
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.battlefield = [attackerId]
    state.players.b.zones.battlefield = [blockerId]
    state.cards[attackerId].summoningSick = false
    state.cards[blockerId].summoningSick = false
    state.phase = 'declare_attackers'
    state.combat.defendingPlayerId = 'b'

    const prematureAdvance = gameReducer(state, { type: 'ADVANCE_PHASE', playerId: 'a' })
    expect(prematureAdvance.accepted).toBe(false)

    const result = reduceActions(state, [
      { type: 'DECLARE_ATTACKERS', playerId: 'a', attackerIds: [attackerId] },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
      { type: 'DECLARE_BLOCKERS', playerId: 'b', assignments: { [attackerId]: [blockerId] } },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(result.accepted).toBe(true)
    expect(result.state.phase).toBe('combat_damage')
    expect(result.state.players.a.zones.graveyard).toContain(attackerId)
    expect(result.state.players.b.zones.graveyard).toContain(blockerId)
  })

  it('keeps an attacker blocked after first strike destroys its blocker', () => {
    const duelist: CardDefinition = { ...bear, id: 'duelist', name: 'Duelist', keywords: ['first strike'] }
    const state = gameWithDecks([duelist], [bear])
    const attackerId = state.players.a.zones.library[0]
    const blockerId = state.players.b.zones.library[0]
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.battlefield = [attackerId]
    state.players.b.zones.battlefield = [blockerId]
    state.cards[attackerId].summoningSick = false
    state.cards[blockerId].summoningSick = false
    state.phase = 'declare_attackers'
    state.combat.defendingPlayerId = 'b'

    const result = reduceActions(state, [
      { type: 'DECLARE_ATTACKERS', playerId: 'a', attackerIds: [attackerId] },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
      { type: 'DECLARE_BLOCKERS', playerId: 'b', assignments: { [attackerId]: [blockerId] } },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(result.state.players.b.life).toBe(20)
    expect(result.state.players.a.zones.battlefield).toContain(attackerId)
    expect(result.state.players.b.zones.graveyard).toContain(blockerId)
  })

  it('does not allow priority actions or phase shortcuts before turn-based declarations', () => {
    const instant: CardDefinition = { id: 'instant', name: 'Quick Thought', types: ['instant'], effects: [{ type: 'draw', amount: 1 }] }
    const state = gameWithDecks([instant, forest], [forest], 1)
    const spellId = state.players.a.zones.hand[0]
    state.phase = 'declare_attackers'
    state.combat.defendingPlayerId = 'b'

    expect(gameReducer(state, { type: 'CAST_SPELL', playerId: 'a', cardId: spellId }).error).toMatch(/Attackers must be declared/)
    expect(gameReducer(state, { type: 'PASS_PRIORITY', playerId: 'a' }).error).toMatch(/Attackers must be declared/)

    const declared = gameReducer(state, { type: 'DECLARE_ATTACKERS', playerId: 'a', attackerIds: [] })
    expect(declared.accepted).toBe(true)
    expect(gameReducer(declared.state, { type: 'ADVANCE_PHASE', playerId: 'a' }).error).toMatch(/every player passes priority/)
    const onePass = gameReducer(declared.state, { type: 'PASS_PRIORITY', playerId: 'a' })
    expect(onePass.state.phase).toBe('declare_attackers')
    expect(onePass.state.priorityPlayerId).toBe('b')
    const allPass = gameReducer(onePass.state, { type: 'PASS_PRIORITY', playerId: 'b' })
    expect(allPass.state.phase).toBe('declare_blockers')
  })

  it('allows creatures with zero power to attack', () => {
    const wallWithoutDefender: CardDefinition = { id: 'zero', name: 'Harmless Witness', types: ['creature'], power: 0, toughness: 3 }
    const state = gameWithDecks([wallWithoutDefender], [forest])
    const attackerId = state.players.a.zones.library[0]
    state.players.a.zones.library = []
    state.players.a.zones.battlefield = [attackerId]
    state.cards[attackerId].summoningSick = false
    state.phase = 'declare_attackers'
    state.combat.defendingPlayerId = 'b'

    expect(gameReducer(state, { type: 'DECLARE_ATTACKERS', playerId: 'a', attackerIds: [attackerId] }).accepted).toBe(true)
  })

  it('gives players priority between first-strike and regular combat damage', () => {
    const striker: CardDefinition = { id: 'striker', name: 'Twinblade', types: ['creature'], keywords: ['double strike', 'trample'], power: 2, toughness: 2 }
    const chump: CardDefinition = { id: 'chump', name: 'Chump', types: ['creature'], power: 1, toughness: 1 }
    const state = gameWithDecks([striker], [chump])
    const attackerId = state.players.a.zones.library[0]
    const blockerId = state.players.b.zones.library[0]
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.battlefield = [attackerId]
    state.players.b.zones.battlefield = [blockerId]
    state.cards[attackerId].summoningSick = false
    state.cards[blockerId].summoningSick = false
    state.phase = 'declare_attackers'
    state.combat.defendingPlayerId = 'b'

    const firstStrikeStep = reduceActions(state, [
      { type: 'DECLARE_ATTACKERS', playerId: 'a', attackerIds: [attackerId] },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
      { type: 'DECLARE_BLOCKERS', playerId: 'b', assignments: { [attackerId]: [blockerId] } },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(firstStrikeStep.state.phase).toBe('combat_damage')
    expect(firstStrikeStep.state.combat.firstStrikeDamageDealt).toBe(true)
    expect(firstStrikeStep.state.combat.damageDealt).toBe(false)
    expect(firstStrikeStep.state.priorityPlayerId).toBe('a')
    expect(firstStrikeStep.state.players.b.life).toBe(19)
    expect(firstStrikeStep.state.players.b.zones.graveyard).toContain(blockerId)

    const regularStep = reduceActions(firstStrikeStep.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(regularStep.state.phase).toBe('combat_damage')
    expect(regularStep.state.combat.damageDealt).toBe(true)
    expect(regularStep.state.players.b.life).toBe(17)

    const endCombat = reduceActions(regularStep.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(endCombat.state.phase).toBe('end_combat')
  })

  it('applies counter cancellation and removes tokens outside the battlefield as state-based actions', () => {
    const tokenMaker: CardDefinition = {
      id: 'maker',
      name: 'Make a Friend',
      types: ['instant'],
      effects: [{
        type: 'create_token',
        amount: 1,
        token: { id: 'spirit-token', name: 'Spirit', types: ['creature'], power: 1, toughness: 1 },
      }],
    }
    const bounce: CardDefinition = {
      id: 'bounce',
      name: 'Dismiss',
      types: ['instant'],
      effects: [{ type: 'return_to_hand', target: { kind: 'target-slot', index: 0 } }],
    }
    const state = gameWithDecks([tokenMaker, bounce], [forest, forest], 2)
    const makerId = state.players.a.zones.hand[0]
    const bounceId = state.players.a.zones.hand[1]
    const made = reduceActions(gameReducer(state, { type: 'CAST_SPELL', playerId: 'a', cardId: makerId }).state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    const tokenId = made.state.players.a.zones.battlefield[0]
    made.state.cards[tokenId].counters['+1/+1'] = 3
    made.state.cards[tokenId].counters['-1/-1'] = 2
    const countersChecked = runStateBasedActions(made.state)
    expect(countersChecked.cards[tokenId].counters['+1/+1']).toBe(1)
    expect(countersChecked.cards[tokenId].counters['-1/-1']).toBeUndefined()
    expect(made.state.cards[tokenId].counters['+1/+1']).toBe(3)

    const bounced = reduceActions(gameReducer(countersChecked, {
      type: 'CAST_SPELL',
      playerId: 'a',
      cardId: bounceId,
      targets: [{ kind: 'permanent', cardId: tokenId }],
    }).state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(bounced.state.cards[tokenId]).toBeUndefined()
    expect(bounced.state.players.a.zones.hand).not.toContain(tokenId)
  })

  it('puts enter-the-battlefield abilities on the stack after the permanent resolves', () => {
    const relic: CardDefinition = {
      id: 'relic',
      name: 'Shattering Relic',
      types: ['artifact'],
      entersEffects: [{ type: 'destroy', target: { kind: 'target-slot', index: 0 } }],
    }
    const target: CardDefinition = { id: 'target', name: 'Target Relic', types: ['artifact'] }
    const state = gameWithDecks([relic], [target], 1)
    const relicId = state.players.a.zones.hand[0]
    const targetId = state.players.b.zones.hand[0]
    state.players.b.zones.hand = []
    state.players.b.zones.battlefield = [targetId]
    state.phase = 'main1'

    const cast = gameReducer(state, { type: 'CAST_SPELL', playerId: 'a', cardId: relicId, targets: [{ kind: 'permanent', cardId: targetId }] })
    const permanentResolved = reduceActions(cast.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])

    expect(permanentResolved.state.players.a.zones.battlefield).toContain(relicId)
    expect(permanentResolved.state.players.b.zones.battlefield).toContain(targetId)
    expect(permanentResolved.state.stack.map((item) => item.name)).toEqual(['Shattering Relic enters the battlefield'])

    const triggerResolved = reduceActions(permanentResolved.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(triggerResolved.state.players.b.zones.graveyard).toContain(targetId)
    expect(triggerResolved.state.stack).toHaveLength(0)
  })

  it('puts token enter-the-battlefield abilities on the stack instead of resolving them inline', () => {
    const summoning: CardDefinition = {
      id: 'summoning',
      name: 'Call the Attendant',
      types: ['sorcery'],
      effects: [{
        type: 'create_token',
        amount: 1,
        token: {
          id: 'attendant-token',
          name: 'Attendant',
          types: ['creature'],
          power: 1,
          toughness: 1,
          entersEffects: [{ type: 'gain_life', amount: 2 }],
        },
      }],
    }
    const state = gameWithDecks([summoning], [forest], 1)
    state.phase = 'main1'
    const spellId = state.players.a.zones.hand[0]

    const spellResolved = reduceActions(gameReducer(state, { type: 'CAST_SPELL', playerId: 'a', cardId: spellId }).state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(spellResolved.state.players.a.life).toBe(20)
    expect(spellResolved.state.stack.map((item) => item.name)).toEqual(['Attendant enters the battlefield'])

    const triggerResolved = reduceActions(spellResolved.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(triggerResolved.state.players.a.life).toBe(22)
    expect(triggerResolved.state.stack).toHaveLength(0)
  })
})

describe('continuous effects', () => {
  it('applies Kird Ape bonus only while its controller controls a Forest', () => {
    const ape: CardDefinition = {
      id: 'kird-ape',
      name: 'Kird Ape',
      types: ['creature'],
      typeLine: 'Creature - Ape',
      oracleText: 'Kird Ape gets +1/+2 as long as you control a Forest.',
      power: 1,
      toughness: 1,
    }
    let state = gameWithDecks([ape, forest], [], 0)
    const [apeId, forestId] = state.players.a.zones.library
    state.players.a.zones.library = [forestId]
    state.players.a.zones.battlefield = [apeId]
    state = runStateBasedActions(state)

    expect([getPower(state.cards[apeId]), getToughness(state.cards[apeId])]).toEqual([1, 1])

    state.players.a.zones.library = []
    state.players.a.zones.battlefield.push(forestId)
    state = runStateBasedActions(state)
    expect([getPower(state.cards[apeId]), getToughness(state.cards[apeId])]).toEqual([2, 3])

    state.players.a.zones.battlefield = [apeId]
    state.players.a.zones.graveyard = [forestId]
    state = runStateBasedActions(state)
    expect([getPower(state.cards[apeId]), getToughness(state.cards[apeId])]).toEqual([1, 1])
  })
})

describe('practice bot', () => {
  it('plays a land before attempting a spell and is deterministic', () => {
    const state = gameWithDecks([forest, bear], [forest, forest], 2)
    state.phase = 'main1'
    const first = chooseBotAction(state, 'a')
    const second = chooseBotAction(state, 'a')
    expect(first).toEqual(second)
    expect(first?.action).toEqual({
      type: 'PLAY_LAND',
      playerId: 'a',
      cardId: state.players.a.zones.hand[0],
    })
  })

  it('casts a permanent whose enters-the-battlefield trigger has no legal target instead of skipping it', () => {
    const relic: CardDefinition = {
      id: 'relic',
      name: 'Shattering Relic',
      types: ['artifact'],
      manaValue: 0,
      entersEffects: [{ type: 'destroy', target: { kind: 'target-slot', index: 0, restriction: 'artifact-or-enchantment' } }],
    }
    const state = gameWithDecks([relic], [forest], 1)
    state.phase = 'main1'
    const decision = chooseBotAction(state, 'a')
    expect(decision?.action).toEqual({
      type: 'CAST_SPELL',
      playerId: 'a',
      cardId: state.players.a.zones.hand[0],
      targets: [],
    })
  })
})

describe('discard to maximum hand size', () => {
  it('forces the active player to discard down to seven cards at cleanup', () => {
    const junk: CardDefinition = { id: 'junk', name: 'Junk', types: ['sorcery'], manaValue: 0 }
    const state = gameWithDecks(Array.from({ length: 9 }, (_, index) => ({ ...junk, id: `junk-${index}`, name: `Junk ${index}` })), [], 9)
    state.phase = 'end'
    state.priorityPlayerId = 'a'
    state.activePlayerId = 'a'

    const enteredCleanup = reduceActions(state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(enteredCleanup.state.phase).toBe('cleanup')
    expect(enteredCleanup.state.pendingDiscard).toBe('a')
    expect(gameReducer(enteredCleanup.state, { type: 'PASS_PRIORITY', playerId: 'a' }).error).toMatch(/discard/i)

    const hand = enteredCleanup.state.players.a.zones.hand
    const discard = gameReducer(enteredCleanup.state, { type: 'DISCARD_CARDS', playerId: 'a', cardIds: hand.slice(0, 2) })
    expect(discard.accepted).toBe(true)
    expect(discard.state.pendingDiscard).toBeNull()
    expect(discard.state.players.a.zones.hand).toHaveLength(7)
    expect(discard.state.players.a.zones.graveyard).toEqual(hand.slice(0, 2))
  })

  it('has the bot discard its lowest-value cards automatically', () => {
    const weak: CardDefinition = { id: 'weak', name: 'Weak', types: ['creature'], manaValue: 1, power: 1, toughness: 1 }
    const medium: CardDefinition = { id: 'medium', name: 'Medium', types: ['creature'], manaValue: 3, power: 3, toughness: 3 }
    const state = gameWithDecks([], [], 0)
    const handIds = ['weak', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
    state.players.a.zones.hand = handIds
    state.pendingDiscard = 'a'
    // Build minimal card instances directly rather than drawing from a deck, to control value precisely.
    const makeCard = (definition: CardDefinition, id: string) => ({
      ...definition,
      instanceId: id,
      ownerId: 'a',
      controllerId: 'a',
      tapped: false,
      counters: {},
      damageMarked: 0,
      summoningSick: false,
      enteredTurn: 1,
      temporaryPower: 0,
      temporaryToughness: 0,
      continuousPower: 0,
      continuousToughness: 0,
      attacking: false,
      blocking: null,
      token: false,
      grantedKeywords: [],
    })
    state.cards.weak = makeCard(weak, 'weak')
    for (const id of handIds.slice(1)) state.cards[id] = makeCard(medium, id)
    const decision = chooseBotAction(state, 'a')
    expect(decision?.action.type).toBe('DISCARD_CARDS')
    if (decision?.action.type === 'DISCARD_CARDS') {
      expect(decision.action.cardIds).toEqual(['weak'])
    }
  })
})

describe('legend rule', () => {
  it('keeps only one copy of a legendary permanent per controller', () => {
    const legend: CardDefinition = {
      id: 'legend',
      name: 'Questing Beast',
      types: ['creature'],
      typeLine: 'Legendary Creature - Beast',
      power: 4,
      toughness: 4,
    }
    const state = gameWithDecks([legend, legend], [], 0)
    const [firstId, secondId] = state.players.a.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.battlefield = [firstId, secondId]
    state.cards[firstId].enteredTurn = 1
    state.cards[secondId].enteredTurn = 2
    const next = runStateBasedActions(state)

    expect(next.players.a.zones.battlefield).toEqual([secondId])
    expect(next.players.a.zones.graveyard).toEqual([firstId])
  })

  it('does not affect two different legendary permanents', () => {
    const beast: CardDefinition = { id: 'beast', name: 'Questing Beast', types: ['creature'], typeLine: 'Legendary Creature - Beast', power: 4, toughness: 4 }
    const cleave: CardDefinition = { id: 'cleave', name: 'Embercleave', types: ['artifact'], typeLine: 'Legendary Artifact - Equipment' }
    const state = gameWithDecks([beast, cleave], [], 0)
    const [beastId, cleaveId] = state.players.a.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.battlefield = [beastId, cleaveId]
    const next = runStateBasedActions(state)

    expect(next.players.a.zones.battlefield).toEqual(expect.arrayContaining([beastId, cleaveId]))
    expect(next.players.a.zones.graveyard).toEqual([])
  })
})

describe('attacker-chosen damage order', () => {
  it('lets the attacking player reorder declared blockers before damage', () => {
    const ogre: CardDefinition = { id: 'ogre', name: 'Ogre', types: ['creature'], power: 2, toughness: 2 }
    const goat: CardDefinition = { id: 'goat', name: 'Goat', types: ['creature'], power: 1, toughness: 1 }
    const wall: CardDefinition = { id: 'wall', name: 'Wall', types: ['creature'], power: 0, toughness: 3 }
    const state = gameWithDecks([ogre], [goat, wall])
    const attackerId = state.players.a.zones.library[0]
    const [goatId, wallId] = state.players.b.zones.library
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.battlefield = [attackerId]
    state.players.b.zones.battlefield = [goatId, wallId]
    state.cards[attackerId].summoningSick = false
    state.cards[goatId].summoningSick = false
    state.cards[wallId].summoningSick = false
    state.phase = 'declare_attackers'
    state.combat.defendingPlayerId = 'b'

    const blocked = reduceActions(state, [
      { type: 'DECLARE_ATTACKERS', playerId: 'a', attackerIds: [attackerId] },
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
      { type: 'DECLARE_BLOCKERS', playerId: 'b', assignments: { [attackerId]: [wallId, goatId] } },
    ])
    expect(blocked.accepted).toBe(true)
    // The defender declared wall-then-goat; the attacker reorders to kill the goat first with overflow onto the wall.
    const reordered = gameReducer(blocked.state, { type: 'ORDER_BLOCKERS', playerId: 'a', attackerId, order: [goatId, wallId] })
    expect(reordered.accepted).toBe(true)
    expect(reordered.state.combat.blockers[attackerId]).toEqual([goatId, wallId])

    const damageDealt = reduceActions(reordered.state, [
      { type: 'PASS_PRIORITY', playerId: 'a' },
      { type: 'PASS_PRIORITY', playerId: 'b' },
    ])
    expect(damageDealt.state.players.b.zones.graveyard).toContain(goatId)
    expect(damageDealt.state.players.b.zones.battlefield).toContain(wallId)
  })
})

describe('bot AI quality', () => {
  it('chump-blocks to avoid lethal instead of only taking favorable trades', () => {
    // Bot ('b') is defending at 4 life against a menace 3/3 plus two vanilla 2/2s, with only two 1/1
    // blockers available. Double-blocking the menace attacker (the "profitable-looking" greedy pick by
    // raw power) leaves both 2/2s completely unblocked for 4 damage - exactly lethal at 4 life. Chump-
    // blocking the two 2/2s instead and letting the menace creature through only deals 3, which survives.
    const menace: CardDefinition = { id: 'menace', name: 'Menace Ogre', types: ['creature'], keywords: ['menace'], power: 3, toughness: 3 }
    const vanillaA: CardDefinition = { id: 'vanillaA', name: 'Vanilla A', types: ['creature'], power: 2, toughness: 2 }
    const vanillaB: CardDefinition = { id: 'vanillaB', name: 'Vanilla B', types: ['creature'], power: 2, toughness: 2 }
    const chump: CardDefinition = { id: 'chump', name: 'Chump', types: ['creature'], power: 1, toughness: 1 }
    const state = gameWithDecks([menace, vanillaA, vanillaB], [chump, chump], 0)
    const [menaceId, vanillaAId, vanillaBId] = state.players.a.zones.library
    const [chumpXId, chumpYId] = state.players.b.zones.library
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.battlefield = [menaceId, vanillaAId, vanillaBId]
    state.players.b.zones.battlefield = [chumpXId, chumpYId]
    for (const id of [menaceId, vanillaAId, vanillaBId, chumpXId, chumpYId]) state.cards[id].summoningSick = false
    state.players.b.life = 4
    state.phase = 'declare_blockers'
    state.combat.defendingPlayerId = 'b'
    state.combat.attackers = [menaceId, vanillaAId, vanillaBId]

    const assignments = chooseBlocks(state, 'b')
    // The menace attacker must go unblocked (only two blockers total, and it alone would eat both).
    expect(assignments[menaceId]).toBeUndefined()
    // Both vanilla attackers must be chump-blocked so the bot survives.
    expect(assignments[vanillaAId]).toBeDefined()
    expect(assignments[vanillaBId]).toBeDefined()
  })

  it('still prefers the greedy value-oriented blocks when nothing is at risk of dying', () => {
    // Same shape of board, but at a life total high enough that letting everything through is fine -
    // the bot should keep double-blocking the menace attacker (the original, value-seeking behavior)
    // rather than being forced into an unnecessary chump-block pattern.
    const menace: CardDefinition = { id: 'menace', name: 'Menace Ogre', types: ['creature'], keywords: ['menace'], power: 3, toughness: 3 }
    const vanillaA: CardDefinition = { id: 'vanillaA', name: 'Vanilla A', types: ['creature'], power: 2, toughness: 2 }
    const vanillaB: CardDefinition = { id: 'vanillaB', name: 'Vanilla B', types: ['creature'], power: 2, toughness: 2 }
    const chump: CardDefinition = { id: 'chump', name: 'Chump', types: ['creature'], power: 1, toughness: 1 }
    const state = gameWithDecks([menace, vanillaA, vanillaB], [chump, chump], 0)
    const [menaceId, vanillaAId, vanillaBId] = state.players.a.zones.library
    const [chumpXId, chumpYId] = state.players.b.zones.library
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.battlefield = [menaceId, vanillaAId, vanillaBId]
    state.players.b.zones.battlefield = [chumpXId, chumpYId]
    for (const id of [menaceId, vanillaAId, vanillaBId, chumpXId, chumpYId]) state.cards[id].summoningSick = false
    state.players.b.life = 20
    state.phase = 'declare_blockers'
    state.combat.defendingPlayerId = 'b'
    state.combat.attackers = [menaceId, vanillaAId, vanillaBId]

    const assignments = chooseBlocks(state, 'b')
    expect(assignments[menaceId]).toEqual(expect.arrayContaining([chumpXId, chumpYId]))
  })

  it('holds an instant-speed removal spell in its own precombat main instead of firing it proactively', () => {
    // Lightning Bolt-shaped instant that deals damage to a target. On an unthreatening board (nothing
    // to answer, opponent hasn't attacked), the bot should hold priority rather than blow the spell now.
    const bolt: CardDefinition = {
      id: 'bolt',
      name: 'Shock',
      types: ['instant'],
      manaCost: '{R}',
      manaValue: 1,
      effects: [{ type: 'damage', amount: 2, target: { kind: 'target-slot', index: 0, restriction: 'creature' } }],
    }
    const opposingBear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 }
    const state = gameWithDecks([bolt], [opposingBear], 0)
    state.phase = 'main1'
    const [boltId] = state.players.a.zones.library
    const [bearId] = state.players.b.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.hand = [boltId]
    state.players.b.zones.library = []
    state.players.b.zones.battlefield = [bearId]
    state.cards[bearId].summoningSick = false
    // Give the bot enough mana in its pool to pay for the bolt right now, so the only thing stopping
    // it from casting is the new hold-up heuristic, not a mana shortage.
    state.players.a.manaPool.R = 1

    const decision = chooseBotAction(state, 'a')
    expect(decision?.action.type).not.toBe('CAST_SPELL')
  })

  it('still casts the held instant right away when responding to something on the stack', () => {
    const bolt: CardDefinition = {
      id: 'bolt',
      name: 'Shock',
      types: ['instant'],
      manaCost: '{R}',
      manaValue: 1,
      effects: [{ type: 'damage', amount: 2, target: { kind: 'target-slot', index: 0, restriction: 'creature' } }],
    }
    const opposingBear: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 }
    const growth: CardDefinition = { id: 'growth', name: 'Giant Growth', types: ['instant'], manaCost: '{G}', manaValue: 1, effects: [] }
    const state = gameWithDecks([bolt], [opposingBear], 0)
    state.phase = 'main1'
    const [boltId] = state.players.a.zones.library
    const [bearId] = state.players.b.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.hand = [boltId]
    state.players.b.zones.library = []
    state.players.b.zones.battlefield = [bearId]
    state.cards[bearId].summoningSick = false
    state.players.a.manaPool.R = 1
    // Put an opposing spell on the stack targeting nothing in particular - the point is just that the
    // stack is non-empty, which is the correct response window.
    state.stack = [{
      id: 'stack-1',
      kind: 'spell',
      controllerId: 'b',
      sourceId: bearId,
      name: growth.name,
      effects: [],
      targets: [],
      counterable: true,
    }]
    state.priorityPlayerId = 'a'

    const decision = chooseBotAction(state, 'a')
    expect(decision?.action.type).toBe('CAST_SPELL')
  })

  it('prefers a land that produces a color the hand actually needs over an earlier alphabetical land', () => {
    // The bot holds a green spell but no red spell. Between an alphabetically-earlier Mountain and a
    // Forest, it should play the Forest because that's the color its hand can actually use.
    const forestLand: CardDefinition = { id: 'forestLand', name: 'Forest', types: ['land'], producesMana: { G: 1 } }
    const mountainLand: CardDefinition = { id: 'mountainLand', name: 'Mountain', types: ['land'], producesMana: { R: 1 } }
    const greenSpell: CardDefinition = { id: 'greenSpell', name: 'Green Spell', types: ['creature'], manaCost: '{G}', manaValue: 1, power: 1, toughness: 1 }
    const state = gameWithDecks([mountainLand, forestLand, greenSpell], [forest], 0)
    const [mountainId, forestId, greenSpellId] = state.players.a.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.hand = [mountainId, forestId, greenSpellId]
    state.phase = 'main1'

    const decision = chooseBotAction(state, 'a')
    expect(decision?.action).toEqual({ type: 'PLAY_LAND', playerId: 'a', cardId: forestId })
  })
})


describe('equip/attach subsystem (Phase 4)', () => {
  it('grants +1/+1, double strike and trample while equipped, and detaches without dangling when the creature dies', () => {
    const embercleave: CardDefinition = {
      id: 'embercleave',
      name: 'Embercleave',
      types: ['artifact'],
      manaCost: '{4}{R}{R}',
      manaValue: 6,
      equip: { cost: '{3}' },
      attachGrant: { power: 1, toughness: 1, keywords: ['double strike', 'trample'] },
    }
    const state = gameWithDecks([bear, embercleave], [forest], 0)
    const [bearId, embercleaveId] = state.players.a.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.battlefield = [bearId, embercleaveId]
    state.cards[bearId].summoningSick = false
    state.phase = 'main1'
    state.activePlayerId = 'a'
    state.priorityPlayerId = 'a'
    state.players.a.manaPool.C = 3

    const equip = gameReducer(state, {
      type: 'ACTIVATE_ABILITY',
      playerId: 'a',
      sourceId: embercleaveId,
      name: 'Equip Embercleave',
      effects: [{ type: 'attach', target: { kind: 'target-slot', index: 0, restriction: 'controlled-creature' } }],
      targets: [{ kind: 'permanent', cardId: bearId }],
      manaCost: '{3}',
      sorcerySpeedOnly: true,
      manaAbility: true,
    })
    expect(equip.accepted).toBe(true)
    const equippedBear = equip.state.cards[bearId]
    expect(getPower(equippedBear)).toBe(3)
    expect(getToughness(equippedBear)).toBe(3)
    expect(hasKeyword(equippedBear, 'double strike')).toBe(true)
    expect(hasKeyword(equippedBear, 'trample')).toBe(true)
    expect(equip.state.cards[embercleaveId].attachedToId).toBe(bearId)

    // Equip is sorcery-speed only and requires controlling both the equipment and the target creature.
    const duringCombat = { ...equip.state, phase: 'declare_attackers' as const, combat: { ...equip.state.combat, attackersDeclared: true } }
    expect(checkAction(duringCombat, {
      type: 'ACTIVATE_ABILITY',
      playerId: 'a',
      sourceId: embercleaveId,
      name: 'Equip Embercleave',
      effects: [{ type: 'attach', target: { kind: 'target-slot', index: 0, restriction: 'controlled-creature' } }],
      targets: [{ kind: 'permanent', cardId: bearId }],
      manaCost: '{3}',
      sorcerySpeedOnly: true,
    }).legal).toBe(false)

    // Kill the equipped creature: the equipment should fall off but stay on the battlefield, not point
    // at a card that no longer exists there.
    const lethal = {
      ...equip.state,
      cards: { ...equip.state.cards, [bearId]: { ...equip.state.cards[bearId], damageMarked: 99 } },
    }
    const afterDeath = runStateBasedActions(lethal)
    expect(afterDeath.players.a.zones.graveyard).toContain(bearId)
    expect(afterDeath.players.a.zones.battlefield).toContain(embercleaveId)
    expect(afterDeath.cards[embercleaveId].attachedToId).toBeUndefined()
    expect(getPower(afterDeath.cards[embercleaveId])).toBe(0)
  })
})

describe('non-mana activated ability costs (Phase 4)', () => {
  it('rejects a discard-cost ability when it cannot be paid, and pays it correctly when it can', () => {
    const source: CardDefinition = { id: 'source', name: 'Source', types: ['artifact'] }
    const filler: CardDefinition = { id: 'filler', name: 'Filler', types: ['creature'], power: 1, toughness: 1 }
    const state = gameWithDecks([source, filler], [forest], 0)
    const [sourceId, fillerId] = state.players.a.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.battlefield = [sourceId]
    state.players.a.zones.hand = [fillerId]
    state.phase = 'main1'

    const abilityAction = (discardCardIds: string[]) => ({
      type: 'ACTIVATE_ABILITY' as const,
      playerId: 'a',
      sourceId,
      name: 'Discard a card: gain 1 life',
      effects: [{ type: 'gain_life' as const, amount: 1 }],
      discardCount: 1,
      discardCardIds,
      manaAbility: true,
    })

    expect(checkAction(state, abilityAction([])).legal).toBe(false)

    const result = gameReducer(state, abilityAction([fillerId]))
    expect(result.accepted).toBe(true)
    expect(result.state.players.a.zones.graveyard).toContain(fillerId)
    expect(result.state.players.a.zones.hand).toHaveLength(0)
    expect(result.state.players.a.life).toBe(21)
  })

  it('rejects a pay-life cost the player cannot afford', () => {
    const source: CardDefinition = { id: 'source', name: 'Source', types: ['artifact'] }
    const state = gameWithDecks([source], [forest], 0)
    const [sourceId] = state.players.a.zones.library
    state.players.a.zones.library = []
    state.players.a.zones.battlefield = [sourceId]
    state.phase = 'main1'
    state.players.a.life = 2

    const tooExpensive = checkAction(state, {
      type: 'ACTIVATE_ABILITY',
      playerId: 'a',
      sourceId,
      name: 'Pay 3 life: draw a card',
      effects: [],
      payLife: 3,
    })
    expect(tooExpensive.legal).toBe(false)

    state.players.a.life = 5
    const payable = gameReducer(state, {
      type: 'ACTIVATE_ABILITY',
      playerId: 'a',
      sourceId,
      name: 'Pay 3 life: draw a card',
      effects: [],
      payLife: 3,
    })
    expect(payable.accepted).toBe(true)
    expect(payable.state.players.a.life).toBe(2)
  })
})

describe('opponent-controlled-creature target restriction (Phase 4)', () => {
  it('only allows targeting a creature an opponent controls, not one you control yourself', () => {
    const removal: CardDefinition = {
      id: 'removal',
      name: 'Focused Bolt',
      types: ['instant'],
      manaCost: '{R}',
      manaValue: 1,
      effects: [{ type: 'damage', amount: 3, target: { kind: 'target-slot', index: 0, restriction: 'opponent-creature' } }],
    }
    const ownBear: CardDefinition = { id: 'ownBear', name: 'Own Bear', types: ['creature'], power: 2, toughness: 2 }
    const enemyBear: CardDefinition = { id: 'enemyBear', name: 'Enemy Bear', types: ['creature'], power: 2, toughness: 2 }
    const state = gameWithDecks([removal, ownBear], [enemyBear], 0)
    const [removalId, ownBearId] = state.players.a.zones.library
    const [enemyBearId] = state.players.b.zones.library
    state.players.a.zones.library = []
    state.players.b.zones.library = []
    state.players.a.zones.hand = [removalId]
    state.players.a.zones.battlefield = [ownBearId]
    state.players.b.zones.battlefield = [enemyBearId]
    state.phase = 'main1'
    state.players.a.manaPool.R = 1

    const illegal = checkAction(state, { type: 'CAST_SPELL', playerId: 'a', cardId: removalId, targets: [{ kind: 'permanent', cardId: ownBearId }] })
    expect(illegal.legal).toBe(false)

    const legalResult = gameReducer(state, { type: 'CAST_SPELL', playerId: 'a', cardId: removalId, targets: [{ kind: 'permanent', cardId: enemyBearId }] })
    expect(legalResult.accepted).toBe(true)
  })
})
