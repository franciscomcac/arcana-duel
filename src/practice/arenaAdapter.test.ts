import { describe, expect, it } from 'vitest'
import { catalog } from '../catalog'
import { createGame, gameReducer, type CardDefinition } from '../engine'
import { catalogCardToDefinition, castWithAutomaticMana, legalTargets } from './arenaAdapter'

describe('arena target restrictions', () => {
  it('preserves artifact-or-enchantment wording from oracle text', () => {
    const sage = catalog.find((card) => card.id === 'reclamation-sage')
    expect(sage).toBeDefined()
    const definition = catalogCardToDefinition(sage!)
    const target = definition.entersEffects?.find((effect) => 'target' in effect)?.target

    expect(target).toMatchObject({
      kind: 'target-slot',
      index: 0,
      restriction: 'artifact-or-enchantment',
    })
  })

  it('does not offer creatures or lands for an artifact-or-enchantment effect', () => {
    const shatterMage: CardDefinition = {
      id: 'shatter-mage',
      name: 'Shatter Mage',
      types: ['creature'],
      power: 2,
      toughness: 2,
      entersEffects: [{ type: 'destroy', target: { kind: 'target-slot', index: 0, restriction: 'artifact-or-enchantment' } }],
    }
    const relic: CardDefinition = { id: 'relic', name: 'Ancient Relic', types: ['artifact'] }
    const bear: CardDefinition = { id: 'bear', name: 'Rune Bear', types: ['creature'], power: 2, toughness: 2 }
    const forest: CardDefinition = { id: 'forest', name: 'Forest', types: ['land'], producesMana: { G: 1 } }
    const state = createGame({
      players: [
        { id: 'a', name: 'Ari', deck: [shatterMage] },
        { id: 'b', name: 'Bea', deck: [relic, bear, forest] },
      ],
      openingHandSize: 0,
    })
    const sourceId = state.players.a.zones.library[0]
    const [relicId, bearId, forestId] = state.players.b.zones.library
    state.players.b.zones.library = []
    state.players.b.zones.battlefield = [relicId, bearId, forestId]

    expect(legalTargets(state, 'a', sourceId)).toEqual([{ kind: 'permanent', cardId: relicId }])
  })

  it('offers players as legal any-targets', () => {
    const bolt: CardDefinition = {
      id: 'bolt',
      name: 'Arc Bolt',
      types: ['instant'],
      effects: [{ type: 'damage', amount: 3, target: { kind: 'target-slot', index: 0, restriction: 'any-target' } }],
    }
    const state = createGame({
      players: [
        { id: 'a', name: 'Ari', deck: [bolt] },
        { id: 'b', name: 'Bea', deck: [] },
      ],
      openingHandSize: 1,
    })
    const boltId = state.players.a.zones.hand[0]
    expect(legalTargets(state, 'a', boltId)).toEqual(expect.arrayContaining([{ kind: 'player', playerId: 'a' }, { kind: 'player', playerId: 'b' }]))
  })
})

describe('catalog mana production', () => {
  it('lets Rockfall Vale tap for either red or green', () => {
    const rockfallVale = catalog.find((card) => card.id === 'rockfall-vale')
    expect(rockfallVale).toBeDefined()
    const definition = catalogCardToDefinition(rockfallVale!)
    expect(definition.producesMana).toEqual({ R: 1, G: 1 })
  })
})

describe('optional enters-the-battlefield targets', () => {
  it('lets Reclamation Sage resolve with no legal artifact/enchantment on the battlefield', () => {
    const sage = catalog.find((card) => card.id === 'reclamation-sage')
    expect(sage).toBeDefined()
    const forest = catalog.find((card) => card.id === 'forest')!
    const definition = catalogCardToDefinition(sage!)
    const state = createGame({
      players: [
        { id: 'a', name: 'Ari', deck: [definition, ...Array.from({ length: 3 }, () => catalogCardToDefinition(forest)) ] },
        { id: 'b', name: 'Bea', deck: [] },
      ],
      openingHandSize: 0,
    })
    const sageId = state.players.a.zones.library[0]
    const forestIds = state.players.a.zones.library.slice(1, 4)
    state.players.a.zones.library = []
    state.players.a.zones.hand = [sageId]
    state.players.a.zones.battlefield = forestIds
    state.phase = 'main1'

    const cast = castWithAutomaticMana(state, 'a', sageId)
    expect(cast.accepted).toBe(true)
    expect(cast.state.stack.at(-1)?.name).toBe('Reclamation Sage')

    const spellResolved = gameReducer(gameReducer(cast.state, { type: 'PASS_PRIORITY', playerId: 'a' }).state, { type: 'PASS_PRIORITY', playerId: 'b' })
    expect(spellResolved.state.players.a.zones.battlefield).toContain(sageId)
    expect(spellResolved.state.stack.map((item) => item.name)).toEqual(['Reclamation Sage enters the battlefield'])

    const triggerResolved = gameReducer(gameReducer(spellResolved.state, { type: 'PASS_PRIORITY', playerId: 'a' }).state, { type: 'PASS_PRIORITY', playerId: 'b' })
    // The ETB trigger with no legal target fizzles instead of leaving anything stuck.
    expect(triggerResolved.state.stack).toHaveLength(0)
    expect(triggerResolved.state.players.a.zones.battlefield).toContain(sageId)
  })
})
