import { afterEach, describe, expect, it, vi } from 'vitest'
import { isEnglishScryfallCard, iterateAllPrintings, parseOracleText, searchCards } from './scryfall'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('parseOracleText', () => {
  it('normalizes evergreen keywords into executable actions', () => {
    const parsed = parseOracleText('Flying, vigilance, trample')
    expect(parsed.keywords).toEqual(expect.arrayContaining(['flying', 'vigilance', 'trample']))
    expect(parsed.actions.filter((action) => action.kind === 'keyword')).toHaveLength(3)
  })

  it('extracts triggered damage and its target', () => {
    const parsed = parseOracleText('When Ember Adept enters the battlefield, it deals 3 damage to any target.', 'Ember Adept')
    const damage = parsed.actions.find((action) => action.kind === 'deal-damage')
    expect(damage).toMatchObject({ kind: 'deal-damage', amount: 3, target: 'any-target', trigger: 'enters' })
  })

  it('preserves unsupported clauses for validation instead of silently dropping them', () => {
    const parsed = parseOracleText('The Ring tempts you.')
    expect(parsed.unsupportedClauses).toEqual(['The Ring tempts you.'])
    expect(parsed.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unparsed' })]))
  })

  it('recognizes ability-word prefixes and beginning-of-combat triggers', () => {
    const parsed = parseOracleText('Raid — At the beginning of combat on your turn, create two 1/1 red Goblin creature tokens.')
    expect(parsed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'create-token', amount: 2, trigger: 'begin-combat', token: '1/1 red Goblin creature' }),
    ]))
  })

  it('distinguishes card-draw and life-gain events from phase triggers', () => {
    const drawTrigger = parseOracleText('Whenever you draw your second card each turn, put a +1/+1 counter on this creature.')
    const lifeTrigger = parseOracleText('Whenever you gain life, put a +1/+1 counter on this creature.')
    expect(drawTrigger.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'put-counters', amount: 1, counter: '+1/+1', target: 'source', trigger: 'card-drawn' }),
    ]))
    expect(lifeTrigger.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'put-counters', trigger: 'life-gained' }),
    ]))
  })

  it('keeps conditional follow-ups and unsupported sentences separate', () => {
    const parsed = parseOracleText("When Grave Hunter enters, destroy target creature. It can't be regenerated. If you do, draw a card.", 'Grave Hunter')
    expect(parsed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'destroy', trigger: 'enters', target: 'target-creature' }),
      expect.objectContaining({ kind: 'draw-cards', trigger: 'enters', condition: expect.stringContaining('if you do') }),
    ]))
    expect(parsed.unsupportedClauses).toEqual(["It can't be regenerated."])
  })

  it('models source-relative amounts instead of discarding them as unknown text', () => {
    const parsed = parseOracleText('Ashling deals damage equal to its power to any target.', 'Ashling')
    expect(parsed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'deal-damage', amount: 'source-power', target: 'any-target' }),
    ]))
  })

  it('extracts word-numbered tokens and counter removal', () => {
    const parsed = parseOracleText('Create three 2/2 green Wolf creature tokens. Remove all time counters from target permanent.')
    expect(parsed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'create-token', amount: 3, token: '2/2 green Wolf creature' }),
      expect.objectContaining({ kind: 'remove-counters', amount: 'variable', counter: 'time', target: 'target-permanent' }),
    ]))
  })

  it('extracts search destinations and graveyard returns', () => {
    const parsed = parseOracleText('Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Return target artifact card from your graveyard to your hand.')
    expect(parsed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'search-library', cardConstraint: 'a basic land card', destination: 'battlefield', tapped: true }),
      expect.objectContaining({ kind: 'return-to-zone', zone: 'hand', target: 'target-permanent' }),
    ]))
  })
})

describe('Scryfall pagination', () => {
  it('walks the cards search endpoint and follows every next_page URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'printing-1', lang: 'en' }],
        has_more: true,
        next_page: 'https://api.scryfall.com/cards/search?q=%2A&page=2',
        total_cards: 2,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'printing-2', lang: 'en' }],
        has_more: false,
        total_cards: 2,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const ids: string[] = []
    for await (const page of iterateAllPrintings({ retries: 0 })) {
      ids.push(...page.map((card) => card.id))
    }

    expect(ids).toEqual(['printing-1', 'printing-2'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://api.scryfall.com/cards/search?')
    expect(String(fetchMock.mock.calls[0][0])).toContain('lang%3Aen')
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.scryfall.com/cards/search?q=%2A&page=2')
  })

  it('rejects malformed pagination before silently truncating an import', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      object: 'list',
      data: [],
      has_more: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const iterator = iterateAllPrintings({ retries: 0 })
    await expect(iterator.next()).rejects.toThrow('did not provide next_page')
  })

  it('retries transient server errors and returns the recovered response', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: 'error',
        status: 503,
        code: 'service_unavailable',
        details: 'Try again.',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: 'list',
        data: [],
        has_more: false,
        total_cards: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(searchCards('lightning bolt', { retries: 1 })).resolves.toMatchObject({ has_more: false, data: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('English-only card policy', () => {
  it('recognizes only explicitly English cards', () => {
    expect(isEnglishScryfallCard({ lang: 'en' })).toBe(true)
    expect(isEnglishScryfallCard({ lang: 'ja' })).toBe(false)
  })

  it('filters mixed-language search pages and requests canonical cards', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'english', lang: 'en' },
        { id: 'japanese', lang: 'ja' },
        { id: 'italian', lang: 'it' },
      ],
      has_more: false,
      total_cards: 3,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await searchCards('Gandalf', { retries: 0 })

    expect(response.data.map((card) => card.id)).toEqual(['english'])
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('lang%3Aen')
    expect(url).toContain('unique=cards')
    expect(url).toContain('include_multilingual=false')
  })
})
