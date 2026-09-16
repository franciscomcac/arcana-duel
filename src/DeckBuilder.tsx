import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  BarChart3,
  Check,
  ChevronLeft,
  Cloud,
  CloudOff,
  Copy,
  Download,
  FileInput,
  Grid2X2,
  Layers3,
  List,
  LoaderCircle,
  Minus,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CardPeek, CardZoom } from './CardZoom'
import { catalog, resolveDeckCard, starterDeck, type CatalogCard, type DeckEntry, type SavedDeck } from './catalog'
import { evaluateDeckLegality, SUPPORTED_FORMATS } from './deckLegality'
import {
  getCardCollection,
  getCardNamedExact,
  getCardNamedFuzzy,
  useScryfallSearch,
  type ScryfallCard,
} from './services/scryfall'
import type { DeckSyncStatus } from './services/deckRepository'

type DeckBuilderProps = {
  decks: SavedDeck[]
  setDecks: React.Dispatch<React.SetStateAction<SavedDeck[]>>
  syncStatus?: DeckSyncStatus
  initialDeckId?: string
  onBack: () => void
}

type ParsedImportLine = {
  lineNumber: number
  source: string
  quantity: number
  name: string
  setCode?: string
  collectorNumber?: string
}

type ImportFailure = {
  lineNumber: number
  source: string
  reason: string
}

type ImportedCard = ParsedImportLine & { card: CatalogCard }

const SECTION_HEADER = /^(deck|mainboard|main deck|sideboard|maybeboard|commander|companion|creatures?|lands?|spells?|artifacts?|enchantments?|planeswalkers?)\s*:?(?:\s*\(\d+\))?$/i

const countCards = (entries: DeckEntry[]) => entries.reduce((sum, entry) => sum + entry.quantity, 0)

function fromScryfall(item: ScryfallCard): CatalogCard | null {
  const face = item.card_faces?.[0]
  const image = item.image_uris?.normal || face?.image_uris?.normal
  if (!image || !item.id || !item.name) return null
  const typeLine = item.type_line || face?.type_line || 'Card'
  const colors: string[] = item.colors || face?.colors || []
  const normalizedType = typeLine.toLocaleLowerCase()
  const kind: CatalogCard['kind'] = normalizedType.includes('land')
    ? 'land'
    : normalizedType.includes('creature')
      ? 'creature'
      : normalizedType.includes('instant')
        ? 'instant'
        : normalizedType.includes('sorcery')
          ? 'sorcery'
          : normalizedType.includes('planeswalker')
            ? 'planeswalker'
            : normalizedType.includes('enchantment')
              ? 'enchantment'
              : normalizedType.includes('battle')
                ? 'battle'
                : 'artifact'
  const colorMap: Record<string, CatalogCard['color']> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }
  const color: CatalogCard['color'] = colors.length > 1 ? 'gold' : colorMap[colors[0]] || 'colorless'
  const rarity = `${item.rarity || 'common'}`
  return {
    id: item.id,
    oracleId: item.oracle_id,
    name: item.name,
    image,
    color,
    kind,
    cost: Number(item.cmc || 0),
    mana: item.mana_cost || face?.mana_cost || '',
    typeLine,
    rules: item.oracle_text || face?.oracle_text || '',
    rarity: (rarity.charAt(0).toUpperCase() + rarity.slice(1)) as CatalogCard['rarity'],
    setCode: item.set,
    collectorNumber: item.collector_number,
    legalities: item.legalities,
    power: Number.isFinite(Number(item.power || face?.power)) ? Number(item.power || face?.power) : undefined,
    toughness: Number.isFinite(Number(item.toughness || face?.toughness)) ? Number(item.toughness || face?.toughness) : undefined,
  }
}

function parseDeckLine(source: string, lineNumber: number): ParsedImportLine | ImportFailure | null {
  let line = source.trim().replace(/^[-*]\s+/, '').replace(/\s+#.*$/, '').trim()
  if (!line || SECTION_HEADER.test(line)) return null

  let quantity: number
  const quantityFirst = line.match(/^(\d{1,3})\s*x?\s+(.+)$/i)
  const quantityLast = line.match(/^(.+?)\s+x(\d{1,3})$/i)
  if (quantityFirst) {
    quantity = Number(quantityFirst[1])
    line = quantityFirst[2].trim()
  } else if (quantityLast) {
    quantity = Number(quantityLast[2])
    line = quantityLast[1].trim()
  } else {
    return { lineNumber, source, reason: 'Expected a quantity, for example "4 Lightning Bolt".' }
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return { lineNumber, source, reason: 'Quantity must be between 1 and 999.' }
  }

  line = line.replace(/\s+\*F\*$/i, '').trim()
  let setCode: string | undefined
  let collectorNumber: string | undefined
  const annotation = line.match(/\s*[([]([a-z0-9]{2,8})[)\]](?:\s+([a-z0-9-]+))?\s*$/i)
  if (annotation) {
    setCode = annotation[1].toLowerCase()
    collectorNumber = annotation[2]
    line = line.slice(0, annotation.index).trim()
  } else {
    const pipeAnnotation = line.match(/^(.+?)\s*\|\s*([a-z0-9]{2,8})(?:\s*\|\s*([a-z0-9-]+))?$/i)
    if (pipeAnnotation) {
      line = pipeAnnotation[1].trim()
      setCode = pipeAnnotation[2].toLowerCase()
      collectorNumber = pipeAnnotation[3]
    }
  }

  if (!line) return { lineNumber, source, reason: 'Card name is missing.' }
  return { lineNumber, source, quantity, name: line, setCode, collectorNumber }
}

function deckEntriesFromJson(payload: any): ParsedImportLine[] {
  const result: ParsedImportLine[] = []
  const candidates = payload?.boards?.mainboard?.cards || payload?.mainboard || payload?.data?.mainboard || payload?.cards
  const values: any[] = Array.isArray(candidates) ? candidates : candidates && typeof candidates === 'object' ? Object.values(candidates) : []
  values.forEach((entry, index) => {
    const categories = Array.isArray(entry?.categories) ? entry.categories.map((category: unknown) => `${category}`.toLowerCase()) : []
    if (categories.some((category: string) => category.includes('sideboard') || category.includes('maybeboard'))) return
    const name = entry?.card?.name || entry?.name || entry?.card?.oracleCard?.name || entry?.oracleCard?.name
    const quantity = Number(entry?.quantity ?? entry?.count ?? entry?.qty ?? 1)
    if (!name || !Number.isFinite(quantity) || quantity < 1) return
    result.push({
      lineNumber: index + 1,
      source: `${quantity} ${name}`,
      quantity,
      name,
      setCode: entry?.card?.set || entry?.set || entry?.card?.edition?.editioncode || entry?.edition?.editioncode,
      collectorNumber: entry?.card?.cn || entry?.collector_number || entry?.card?.collectorNumber,
    })
  })
  return result
}

function normalizeDeckUrl(source: string): string {
  const url = new URL(source)
  const moxfield = url.hostname.replace(/^www\./, '') === 'moxfield.com' && url.pathname.match(/^\/decks\/([^/]+)/)
  if (moxfield) return `https://api2.moxfield.com/v3/decks/all/${moxfield[1]}`
  const archidekt = url.hostname.replace(/^www\./, '') === 'archidekt.com' && url.pathname.match(/^\/decks\/(\d+)/)
  if (archidekt) return `https://archidekt.com/api/decks/${archidekt[1]}/`
  return url.toString()
}

async function importFromUrl(source: string): Promise<{ lines: ParsedImportLine[]; failures: ImportFailure[] }> {
  const endpoint = normalizeDeckUrl(source)
  let response: Response
  try {
    response = await fetch(endpoint, { headers: { Accept: 'application/json, text/plain, text/html' } })
  } catch {
    throw new Error('The deck host blocked browser access. Export its plain-text list and paste it here instead.')
  }
  if (!response.ok) throw new Error(`The deck URL returned ${response.status}. Check that it is public.`)
  const body = await response.text()
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('json') || /^[\s]*[{[]/.test(body)) {
    try {
      const lines = deckEntriesFromJson(JSON.parse(body))
      if (lines.length) return { lines, failures: [] }
    } catch {
      // Some deck hosts label a plain-text export as JSON; continue as text.
    }
  }

  let deckText = body
  if (/<(?:html|body|pre|textarea|code)[\s>]/i.test(body)) {
    const document = new DOMParser().parseFromString(body, 'text/html')
    deckText = document.querySelector('pre, textarea, code')?.textContent || ''
  }
  if (!deckText.trim()) throw new Error('No plain-text deck list was found at that URL.')
  return parseDeckText(deckText)
}

function parseDeckText(text: string): { lines: ParsedImportLine[]; failures: ImportFailure[] } {
  const lines: ParsedImportLine[] = []
  const failures: ImportFailure[] = []
  text.split(/\r?\n/).forEach((source, index) => {
    const parsed = parseDeckLine(source, index + 1)
    if (!parsed) return
    if ('reason' in parsed) failures.push(parsed)
    else lines.push(parsed)
  })
  return { lines, failures }
}

async function resolveImportCard(line: ParsedImportLine): Promise<CatalogCard> {
  let lastLookupError: unknown
  if (line.setCode && line.collectorNumber) {
    try {
      const [printing] = await getCardCollection([{ set: line.setCode, collector_number: line.collectorNumber }], { retries: 6 })
      const card = printing && fromScryfall(printing)
      if (card && card.name.localeCompare(line.name, undefined, { sensitivity: 'accent' }) === 0) return card
    } catch (error) {
      lastLookupError = error
      // Fall through to name resolution when a printing annotation is stale.
    }
  }
  if (line.setCode) {
    try {
      const card = fromScryfall(await getCardNamedExact(line.name, { set: line.setCode, retries: 6 }))
      if (card) return card
    } catch (error) {
      lastLookupError = error
      // The global fuzzy lookup below still recovers renamed or mistyped cards.
    }
  }

  try {
    const card = fromScryfall(await getCardNamedFuzzy(line.name, { retries: 6 }))
    if (card) return card
  } catch (error) {
    lastLookupError = error
    // The bundled catalog keeps starter cards importable while offline.
  }

  const local = catalog.find((card) => card.name.localeCompare(line.name, undefined, { sensitivity: 'accent' }) === 0)
  if (local) return local
  if (lastLookupError instanceof Error && !/not found/i.test(lastLookupError.message)) throw lastLookupError
  throw new Error('No matching card or printing found on Scryfall.')
}

export function DeckBuilder({ decks, setDecks, syncStatus = 'local', initialDeckId, onBack }: DeckBuilderProps) {
  const searchInput = useRef<HTMLInputElement>(null)
  const [activeId, setActiveId] = useState(initialDeckId || decks[0]?.id)
  const [query, setQuery] = useState('')
  const [color, setColor] = useState('all')
  const [kind, setKind] = useState('all')
  const [zone, setZone] = useState<'entries' | 'sideboard'>('entries')
  const [hovered, setHovered] = useState<CatalogCard | null>(catalog[3])
  const [zoomed, setZoomed] = useState<CatalogCard | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [fuzzyCard, setFuzzyCard] = useState<CatalogCard | null>(null)
  const [fuzzySearching, setFuzzySearching] = useState(false)
  const [fuzzyError, setFuzzyError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState('')
  const [importFailures, setImportFailures] = useState<ImportFailure[]>([])
  const [importSummary, setImportSummary] = useState('')

  const activeDeck = decks.find((deck) => deck.id === activeId) || decks[0]
  const catalogQuery = query.trim() || '*'
  const catalogSearch = useScryfallSearch(catalogQuery, {
    unique: 'cards',
    order: 'name',
    includeExtras: true,
    includeMultilingual: false,
    includeVariations: true,
    retries: 3,
  })
  const remoteCards = useMemo(() => catalogSearch.cards.map(fromScryfall).filter((card): card is CatalogCard => Boolean(card)), [catalogSearch.cards])
  const searching = catalogSearch.loading || catalogSearch.loadingMore || fuzzySearching
  const searchError = catalogSearch.error && !fuzzyCard && !fuzzySearching ? fuzzyError || catalogSearch.error.message : ''

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (event.key === '/' && !isTyping && !importOpen) {
        event.preventDefault()
        searchInput.current?.focus()
      }
      if (event.key === 'Escape' && importOpen && !importing) setImportOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [importOpen, importing])

  useEffect(() => {
    const term = query.trim()
    setFuzzyCard(null)
    setFuzzyError('')
    if (!term || !catalogSearch.error) {
      setFuzzySearching(false)
      return
    }
    const controller = new AbortController()
    setFuzzySearching(true)
    getCardNamedFuzzy(term, { signal: controller.signal })
      .then((card) => setFuzzyCard(fromScryfall(card)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFuzzyError(error instanceof Error ? error.message : 'No cards found')
      })
      .finally(() => {
        if (!controller.signal.aborted) setFuzzySearching(false)
      })
    return () => {
      controller.abort()
    }
  }, [catalogSearch.error, query])

  const filteredCards = useMemo(() => {
    const source = fuzzyCard ? [fuzzyCard] : remoteCards.length ? remoteCards : catalog
    return source.filter((card) => (color === 'all' || card.color === color) && (kind === 'all' || card.kind === kind))
  }, [color, fuzzyCard, kind, remoteCards])

  const commit = (updater: (deck: SavedDeck) => SavedDeck) => {
    setDecks((items) => items.map((deck) => deck.id === activeDeck.id ? { ...updater(deck), updatedAt: Date.now() } : deck))
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 900)
  }

  const changeQuantity = (cardId: string, delta: number, targetZone = zone, card?: CatalogCard) => {
    if (!cardId) return
    commit((deck) => {
      const entries = deck[targetZone]
      const existing = entries.find((entry) => entry.cardId === cardId)
      const next = existing
        ? entries.map((entry) => entry.cardId === cardId ? { ...entry, quantity: Math.max(0, Math.min(99, entry.quantity + delta)) } : entry).filter((entry) => entry.quantity > 0)
        : delta > 0 ? [...entries, { cardId, quantity: 1, card }] : entries
      return { ...deck, [targetZone]: next }
    })
  }

  const runImport = async () => {
    const source = importText.trim()
    if (!source || importing) return
    setImporting(true)
    setImportSummary('')
    setImportFailures([])
    setImportProgress('Reading deck list')
    try {
      let parsed: { lines: ParsedImportLine[]; failures: ImportFailure[] }
      try {
        const url = new URL(source)
        parsed = url.protocol === 'http:' || url.protocol === 'https:' ? await importFromUrl(source) : parseDeckText(source)
      } catch (error) {
        if (/^https?:\/\//i.test(source)) throw error
        parsed = parseDeckText(source)
      }

      if (!parsed.lines.length) {
        setImportFailures(parsed.failures.length ? parsed.failures : [{ lineNumber: 1, source, reason: 'No card lines were found.' }])
        return
      }

      const resolved: ImportedCard[] = []
      const resolutionFailures: ImportFailure[] = [...parsed.failures]
      for (let index = 0; index < parsed.lines.length; index += 1) {
        const line = parsed.lines[index]
        setImportProgress(`Resolving ${index + 1} of ${parsed.lines.length}`)
        try {
          resolved.push({ ...line, card: await resolveImportCard(line) })
        } catch (error) {
          resolutionFailures.push({ lineNumber: line.lineNumber, source: line.source, reason: error instanceof Error ? error.message : 'Card lookup failed.' })
        }
      }

      const quantities = new Map<string, { card: CatalogCard; quantity: number }>()
      resolved.forEach(({ card, quantity }) => {
        const existing = quantities.get(card.id)
        quantities.set(card.id, { card, quantity: (existing?.quantity || 0) + quantity })
      })
      if (quantities.size) {
        commit((deck) => {
          const entries = [...deck.entries]
          quantities.forEach(({ card, quantity }) => {
            const index = entries.findIndex((entry) => entry.cardId === card.id || resolveDeckCard(entry)?.name.toLocaleLowerCase() === card.name.toLocaleLowerCase())
            if (index >= 0) entries[index] = { ...entries[index], quantity: entries[index].quantity + quantity, card: entries[index].card || card }
            else entries.push({ cardId: card.id, quantity, card })
          })
          return { ...deck, entries }
        })
      }
      const importedCount = [...quantities.values()].reduce((sum, entry) => sum + entry.quantity, 0)
      setImportFailures(resolutionFailures.sort((a, b) => a.lineNumber - b.lineNumber))
      setImportSummary(`${importedCount} card${importedCount === 1 ? '' : 's'} added across ${quantities.size} unique name${quantities.size === 1 ? '' : 's'}.`)
      if (!resolutionFailures.length) setImportText('')
    } catch (error) {
      setImportFailures([{ lineNumber: 1, source, reason: (error as Error).message }])
    } finally {
      setImportProgress('')
      setImporting(false)
    }
  }

  const createDeck = () => {
    const fresh = starterDeck()
    fresh.id = `deck-${Date.now()}`
    fresh.name = 'Untitled Deck'
    fresh.entries = []
    fresh.sideboard = []
    setDecks((items) => [...items, fresh])
    setActiveId(fresh.id)
  }

  const duplicateDeck = () => {
    const copy = { ...activeDeck, id: `deck-${Date.now()}`, name: `${activeDeck.name} Copy`, updatedAt: Date.now(), entries: activeDeck.entries.map((entry) => ({ ...entry })), sideboard: activeDeck.sideboard.map((entry) => ({ ...entry })) }
    setDecks((items) => [...items, copy])
    setActiveId(copy.id)
  }

  const deleteDeck = () => {
    if (decks.length === 1) return
    const remaining = decks.filter((deck) => deck.id !== activeDeck.id)
    setDecks(remaining)
    setActiveId(remaining[0].id)
  }

  const curve = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((cost) => activeDeck.entries.reduce((total, entry) => {
    const card = resolveDeckCard(entry)
    return total + (card && Math.min(card.cost, 6) === cost ? entry.quantity : 0)
  }, 0)), [activeDeck])
  const maxCurve = Math.max(...curve, 1)
  const legality = useMemo(() => evaluateDeckLegality(activeDeck), [activeDeck])
  const mainCount = legality.mainboardCount
  const sideboardCount = legality.sideboardCount
  const missingCards = activeDeck.entries.filter((entry) => !resolveDeckCard(entry)).length
  const isReady = legality.legal && !missingCards
  const validationLabel = missingCards
    ? `${missingCards} card ${missingCards === 1 ? 'record is' : 'records are'} unavailable`
    : legality.issues[0]?.message ?? 'Ready to play'

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, DeckEntry[]>()
    activeDeck[zone].forEach((entry) => {
      const card = resolveDeckCard(entry)
      const label = card?.kind === 'land' ? 'Lands' : card?.kind === 'creature' ? 'Creatures' : ['instant', 'sorcery'].includes(card?.kind ?? '') ? 'Spells' : 'Other'
      groups.set(label, [...(groups.get(label) || []), entry])
    })
    return ['Creatures', 'Spells', 'Other', 'Lands'].flatMap((label) => {
      const entries = groups.get(label)
      return entries?.length ? [{ label, entries: entries.sort((a, b) => (resolveDeckCard(a)?.name || '').localeCompare(resolveDeckCard(b)?.name || '')) }] : []
    })
  }, [activeDeck, zone])

  return (
    <motion.div className="builder-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="workspace-bar">
        <button type="button" className="icon-command" onClick={onBack} title="Back to decks"><ChevronLeft /></button>
        <div className="deck-title-edit">
          <input value={activeDeck.name} aria-label="Deck name" onChange={(event) => commit((deck) => ({ ...deck, name: event.target.value }))} />
          <span><select value={activeDeck.format} aria-label="Deck format" onChange={(event) => commit((deck) => ({ ...deck, format: event.target.value }))}>{SUPPORTED_FORMATS.map((format) => <option key={format}>{format}</option>)}</select> · {mainCount} cards</span>
        </div>
        <div className={`save-state ${savedFlash ? 'flash' : ''} ${syncStatus}`} aria-live="polite">
          {syncStatus === 'syncing' && <><LoaderCircle className="spin" /> Syncing</>}
          {syncStatus === 'synced' && <><Cloud /> Synced</>}
          {syncStatus === 'error' && <><CloudOff /> Saved locally</>}
          {syncStatus === 'local' && <><Check /> Saved locally</>}
        </div>
        <div className="workspace-actions">
          <button type="button" className="import-command" onClick={() => setImportOpen(true)}><FileInput /> <span>Import</span></button>
          <button type="button" className="icon-command" onClick={duplicateDeck} title="Duplicate deck"><Copy /></button>
          <button type="button" className="icon-command" title="Copy deck list" onClick={() => navigator.clipboard?.writeText(activeDeck.entries.map((entry) => `${entry.quantity} ${resolveDeckCard(entry)?.name || entry.cardId}`).join('\n'))}><Download /></button>
          <button type="button" className="icon-command danger" onClick={deleteDeck} disabled={decks.length === 1} title="Delete deck"><Trash2 /></button>
        </div>
      </header>

      <aside className="deck-library">
        <div className="section-label"><span>Your decks</span><button type="button" onClick={createDeck} title="New deck"><Plus size={15} /></button></div>
        <div className="deck-library-list">
          {decks.map((deck) => (
            <button type="button" key={deck.id} className={deck.id === activeDeck.id ? 'active' : ''} onClick={() => setActiveId(deck.id)}>
              <span className="deck-color"><i /><i /></span>
              <span><b>{deck.name}</b><small>{deck.format} · {countCards(deck.entries)}</small></span>
            </button>
          ))}
        </div>
        <div className="curve-panel">
          <div className="section-label"><span>Mana curve</span><BarChart3 size={14} /></div>
          <div className="mana-curve">{curve.map((amount, index) => <div key={index}><i style={{ height: `${Math.max(5, amount / maxCurve * 100)}%` }} /><span>{index === 6 ? '6+' : index}</span></div>)}</div>
        </div>
      </aside>

      <section className="catalog-workspace">
        <div className="catalog-tools">
          <label className={`search-field ${searching ? 'is-searching' : ''}`}><Search size={16} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, oracle text, type, or Scryfall query" />{searching ? <i /> : <kbd>/</kbd>}</label>
          <div className="filter-group" aria-label="Color filter">
            {['all', 'white', 'blue', 'black', 'red', 'green', 'gold'].map((item) => <button type="button" key={item} className={color === item ? 'active' : ''} onClick={() => setColor(item)} title={`${item} cards`}><span className={`filter-pip ${item}`} />{item === 'all' ? 'All colors' : item}</button>)}
          </div>
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Card type"><option value="all">All types</option><option value="creature">Creatures</option><option value="instant">Instants</option><option value="sorcery">Sorceries</option><option value="artifact">Artifacts</option><option value="enchantment">Enchantments</option><option value="planeswalker">Planeswalkers</option><option value="battle">Battles</option><option value="land">Lands</option></select>
          <div className="view-toggle"><button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Grid view"><Grid2X2 /></button><button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="List view"><List /></button></div>
        </div>
        <div className={`catalog-grid ${view}`} aria-busy={searching}>
          <AnimatePresence>
            {filteredCards.map((card, index) => (
              <motion.article key={card.id} className="catalog-card" layout initial={{ opacity: 0, scale: .92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .9 }} transition={{ delay: Math.min(index * .018, .16) }} draggable onDragStart={(event) => { const native = event as unknown as DragEvent; native.dataTransfer?.setData('cardId', card.id); native.dataTransfer?.setData('application/json', JSON.stringify(card)) }} onMouseEnter={() => setHovered(card)} onDoubleClick={() => setZoomed(card)}>
                <img src={card.image} alt={card.name} loading="lazy" />
                <div className="catalog-list-copy"><b>{card.name}</b><small>{card.typeLine}</small><p>{card.rules}</p></div>
                <span className="catalog-cost">{card.mana}</span>
                <div className="card-quick-actions"><button type="button" onClick={() => setZoomed(card)} title={`Zoom ${card.name}`}><Search size={14} /></button><button type="button" onClick={() => changeQuantity(card.id, 1, zone, card)} title={`Add ${card.name}`}><Plus size={16} /></button></div>
              </motion.article>
            ))}
          </AnimatePresence>
          {searchError && <div className="catalog-status"><Search /><b>{searchError}</b><span>Try a card name, type, oracle phrase, or Scryfall query.</span></div>}
          {catalogSearch.hasMore && !searchError && <button type="button" className="load-more-cards" onClick={catalogSearch.loadMore} disabled={searching}>{catalogSearch.loadingMore ? 'Loading more cards…' : `Load more cards · ${remoteCards.length}${catalogSearch.totalCards ? ` of ${catalogSearch.totalCards}` : ''} shown`}</button>}
        </div>
      </section>

      <aside className="deck-sheet" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const raw = event.dataTransfer.getData('application/json'); const card = raw ? JSON.parse(raw) as CatalogCard : undefined; changeQuantity(event.dataTransfer.getData('cardId'), 1, zone, card) }}>
        <div className="sheet-tabs">
          <button type="button" className={zone === 'entries' ? 'active' : ''} onClick={() => setZone('entries')}>Main <span>{mainCount}</span></button>
          <button type="button" className={zone === 'sideboard' ? 'active' : ''} onClick={() => setZone('sideboard')}>Sideboard <span>{sideboardCount}</span></button>
        </div>
        <div className="deck-validation">
          <span className={isReady ? 'valid' : ''}>{isReady ? <Check size={12} /> : <AlertCircle size={12} />} {validationLabel}</span>
          <div className="deck-progress" aria-label={`${Math.min(mainCount / legality.minimum * 100, 100)} percent of minimum deck size`}><i style={{ width: `${Math.min(mainCount / legality.minimum * 100, 100)}%` }} /></div>
          <small>{mainCount}/{legality.maximum ?? `${legality.minimum}+`} main · {sideboardCount}/{legality.sideboardMaximum} side</small>
        </div>
        <div className="deck-entries">
          {groupedEntries.map((group) => (
            <div className="deck-entry-group" key={group.label}>
              <div className="entry-group-heading"><span>{group.label}</span><b>{countCards(group.entries)}</b></div>
              {group.entries.map((entry) => {
                const card = resolveDeckCard(entry)
                if (!card) return <div key={entry.cardId} className="deck-entry missing"><span /><span className="entry-qty">{entry.quantity}</span><span className="entry-name">Unknown card · {entry.cardId}</span></div>
                return (
                  <motion.div layout key={entry.cardId} className="deck-entry" onMouseEnter={() => setHovered(card)} onDoubleClick={() => setZoomed(card)}>
                    <span className={`entry-color ${card.color}`} /><span className="entry-qty">{entry.quantity}</span><span className="entry-name">{card.name}</span><span className="entry-mana">{card.mana}</span>
                    <span className="entry-controls"><button type="button" onClick={() => changeQuantity(card.id, -1)} title={`Remove one ${card.name}`}><Minus size={12} /></button><button type="button" onClick={() => changeQuantity(card.id, 1)} title={`Add one ${card.name}`}><Plus size={12} /></button></span>
                  </motion.div>
                )
              })}
            </div>
          ))}
          {!activeDeck[zone].length && <div className="empty-deck"><Layers3 /><b>No cards yet</b><span>Add from the card library or import a list</span></div>}
        </div>
      </aside>

      <AnimatePresence>
        {importOpen && (
          <motion.div className="import-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) setImportOpen(false) }}>
            <motion.section className="import-panel" role="dialog" aria-modal="true" aria-labelledby="import-title" initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: .98 }}>
              <header><div><span>Deck intake</span><h2 id="import-title">Import to mainboard</h2></div><button type="button" onClick={() => setImportOpen(false)} disabled={importing} title="Close importer"><X /></button></header>
              <label htmlFor="deck-import">Plain-text list or public deck URL</label>
              <textarea id="deck-import" value={importText} onChange={(event) => setImportText(event.target.value)} disabled={importing} autoFocus spellCheck={false} placeholder={'4 Lightning Bolt\n4 Monastery Swiftspear (KTK) 118\n20 Mountain\n\nhttps://www.moxfield.com/decks/…'} />
              <div className="import-format"><span><b>Quantity</b> 4x Card Name</span><span><b>Printing</b> (SET) 123</span><span><b>URL</b> Moxfield, Archidekt, or text export</span></div>
              <div className="import-results" aria-live="polite">
                {importSummary && <div className="import-success"><Check /> <span>{importSummary}</span></div>}
                {importFailures.length > 0 && <div className="import-failures"><b>{importFailures.length} line{importFailures.length === 1 ? '' : 's'} not imported</b>{importFailures.map((failure, index) => <div key={`${failure.lineNumber}-${index}`}><span>Line {failure.lineNumber}</span><p>{failure.source}</p><small>{failure.reason}</small></div>)}</div>}
              </div>
              <footer><span>{importProgress || 'Resolved cards are added to the current mainboard.'}</span><button type="button" className="import-submit" onClick={runImport} disabled={importing || !importText.trim()}>{importing ? <><LoaderCircle className="spin" /> Resolving</> : <><FileInput /> Import cards</>}</button></footer>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <CardPeek card={hovered} onOpen={() => setZoomed(hovered)} />
      <CardZoom card={zoomed} onClose={() => setZoomed(null)} />
    </motion.div>
  )
}
