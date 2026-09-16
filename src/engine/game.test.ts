import { describe, expect, it } from 'vitest'
import { chooseBotAction } from './bot'
import { createGame, gameReducer, getPower, getToughness, reduceActions, runStateBasedActions } from './game'
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
})
