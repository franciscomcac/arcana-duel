import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const SCRYFALL_API_ROOT = 'https://api.scryfall.com'
export const SCRYFALL_CARD_PAGE_SIZE = 175
export const SCRYFALL_COLLECTION_LIMIT = 75

export type ScryfallColor = 'W' | 'U' | 'B' | 'R' | 'G'
export type ScryfallLayout =
  | 'normal'
  | 'split'
  | 'flip'
  | 'transform'
  | 'modal_dfc'
  | 'meld'
  | 'leveler'
  | 'class'
  | 'case'
  | 'saga'
  | 'adventure'
  | 'mutate'
  | 'prototype'
  | 'battle'
  | 'planar'
  | 'scheme'
  | 'vanguard'
  | 'token'
  | 'double_faced_token'
  | 'emblem'
  | 'augment'
  | 'host'
  | 'art_series'
  | 'reversible_card'

export interface ScryfallImageUris {
  small: string
  normal: string
  large: string
  png: string
  art_crop: string
  border_crop: string
}

export interface ScryfallCardFace {
  object: 'card_face'
  name: string
  mana_cost: string
  type_line: string
  oracle_text?: string
  colors?: ScryfallColor[]
  color_indicator?: ScryfallColor[]
  power?: string
  toughness?: string
  loyalty?: string
  defense?: string
  flavor_text?: string
  image_uris?: ScryfallImageUris
  artist?: string
}

export interface ScryfallCard {
  object: 'card'
  id: string
  oracle_id?: string
  multiverse_ids: number[]
  mtgo_id?: number
  arena_id?: number
  tcgplayer_id?: number
  cardmarket_id?: number
  lang: string
  released_at: string
  uri: string
  scryfall_uri: string
  layout: ScryfallLayout
  highres_image: boolean
  image_status: 'missing' | 'placeholder' | 'lowres' | 'highres_scan'
  image_uris?: ScryfallImageUris
  mana_cost?: string
  cmc: number
  type_line: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
  defense?: string
  colors?: ScryfallColor[]
  color_identity: ScryfallColor[]
  keywords: string[]
  card_faces?: ScryfallCardFace[]
  produced_mana?: ScryfallColor[]
  legalities: Record<string, 'legal' | 'not_legal' | 'restricted' | 'banned'>
  games: Array<'paper' | 'arena' | 'mtgo'>
  reserved: boolean
  foil: boolean
  nonfoil: boolean
  finishes: Array<'foil' | 'nonfoil' | 'etched' | 'glossy'>
  oversized: boolean
  promo: boolean
  reprint: boolean
  variation: boolean
  set_id: string
  set: string
  set_name: string
  set_type: string
  collector_number: string
  digital: boolean
  rarity: 'common' | 'uncommon' | 'rare' | 'special' | 'mythic' | 'bonus'
  flavor_text?: string
  artist?: string
  border_color: string
  frame: string
  full_art: boolean
  textless: boolean
  booster: boolean
  story_spotlight: boolean
  prices: Record<'usd' | 'usd_foil' | 'usd_etched' | 'eur' | 'eur_foil' | 'tix', string | null>
  related_uris: Record<string, string>
  purchase_uris?: Record<string, string>
  name: string
}

export interface ScryfallList<T> {
  object: 'list'
  data: T[]
  has_more: boolean
  next_page?: string
  total_cards?: number
  warnings?: string[]
}

export interface ScryfallErrorBody {
  object: 'error'
  code: string
  status: number
  details: string
  type?: string
  warnings?: string[]
}

export class ScryfallApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: string
  readonly warnings: string[]

  constructor(body: Partial<ScryfallErrorBody>, status: number) {
    super(body.details || `Scryfall request failed with HTTP ${status}`)
    this.name = 'ScryfallApiError'
    this.status = status
    this.code = body.code || 'unknown_error'
    this.details = body.details || this.message
    this.warnings = body.warnings || []
  }
}

export interface ScryfallRequestOptions {
  signal?: AbortSignal
  retries?: number
}

const delay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('The operation was aborted.', 'AbortError'))
    return
  }
  const onAbort = () => {
    globalThis.clearTimeout(timeout)
    reject(new DOMException('The operation was aborted.', 'AbortError'))
  }
  const timeout = globalThis.setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, milliseconds)
  signal?.addEventListener('abort', onAbort, { once: true })
})

class RequestGate {
  private tail: Promise<void> = Promise.resolve()
  private lastStartedAt = 0

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(async () => {
      const waitFor = Math.max(0, 100 - (Date.now() - this.lastStartedAt))
      if (waitFor > 0) await delay(waitFor, signal)
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      this.lastStartedAt = Date.now()
      return operation()
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

const requestGate = new RequestGate()

function toApiUrl(pathOrUrl: string): URL {
  const url = new URL(pathOrUrl, SCRYFALL_API_ROOT)
  if (url.origin !== SCRYFALL_API_ROOT) {
    throw new TypeError(`Refusing to request a non-Scryfall origin: ${url.origin}`)
  }
  return url
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(100, seconds * 1000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(100, date - Date.now())
  }
  return Math.min(8_000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 150)
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function request<T>(pathOrUrl: string, init: RequestInit, options: ScryfallRequestOptions = {}): Promise<T> {
  const url = toApiUrl(pathOrUrl)
  const requestedRetries = options.retries ?? 4
  const retries = Number.isFinite(requestedRetries)
    ? Math.max(0, Math.min(10, Math.floor(requestedRetries)))
    : 4
  let latestError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response | undefined
    try {
      response = await requestGate.run(() => fetch(url, {
        ...init,
        signal: options.signal,
        headers: {
          Accept: 'application/json',
          ...init.headers,
        },
      }), options.signal)

      if (response.ok) return await response.json() as T

      const body = await response.json().catch(() => ({
        object: 'error',
        status: response?.status || 500,
        code: 'invalid_response',
        details: response?.statusText || 'Scryfall returned an invalid response.',
      })) as Partial<ScryfallErrorBody>
      const apiError = new ScryfallApiError(body, response.status)
      if (!isRetryableStatus(response.status)) throw apiError
      latestError = apiError
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      if (error instanceof ScryfallApiError && !isRetryableStatus(error.status)) throw error
      latestError = error
    }

    if (attempt < retries) await delay(retryDelay(response, attempt), options.signal)
  }

  if (latestError instanceof Error) throw latestError
  throw new Error('Scryfall request failed after all retry attempts.')
}

function validateListResponse<T>(value: ScryfallList<T>): ScryfallList<T> {
  if (value?.object !== 'list' || !Array.isArray(value.data) || typeof value.has_more !== 'boolean') {
    throw new TypeError('Scryfall returned an invalid list response.')
  }
  if (value.has_more && (typeof value.next_page !== 'string' || !value.next_page.trim())) {
    throw new TypeError('Scryfall indicated another page but did not provide next_page.')
  }
  if (value.next_page) toApiUrl(value.next_page)
  return value
}

export function isEnglishScryfallCard(card: Pick<ScryfallCard, 'lang'>): boolean {
  return card.lang === 'en'
}

function englishCardList(value: ScryfallList<ScryfallCard>): ScryfallList<ScryfallCard> {
  const validated = validateListResponse(value)
  return { ...validated, data: validated.data.filter(isEnglishScryfallCard) }
}

function englishQuery(query: string): string {
  return /(?:^|\s)lang:/i.test(query) ? query : `${query} lang:en`
}

function withQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const url = toApiUrl(path)
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, String(value))
  })
  return url.toString()
}

export interface CardSearchOptions extends ScryfallRequestOptions {
  page?: number
  unique?: 'cards' | 'art' | 'prints'
  order?: 'name' | 'set' | 'released' | 'rarity' | 'color' | 'usd' | 'tix' | 'eur' | 'cmc' | 'power' | 'toughness' | 'edhrec' | 'penny' | 'artist' | 'review'
  direction?: 'auto' | 'asc' | 'desc'
  includeExtras?: boolean
  includeMultilingual?: boolean
  includeVariations?: boolean
}

export function searchCards(query: string, options: CardSearchOptions = {}): Promise<ScryfallList<ScryfallCard>> {
  const trimmed = query.trim()
  if (!trimmed) return Promise.reject(new TypeError('A non-empty Scryfall search query is required.'))
  return request<ScryfallList<ScryfallCard>>(withQuery('/cards/search', {
    q: englishQuery(trimmed),
    page: options.page,
    unique: options.unique ?? 'cards',
    order: options.order,
    dir: options.direction,
    include_extras: options.includeExtras,
    include_multilingual: options.includeMultilingual ?? false,
    include_variations: options.includeVariations,
  }), { method: 'GET' }, options).then(englishCardList)
}

export interface AllPrintingsOptions extends ScryfallRequestOptions {
  page?: number
}

export function getPrintingsPage(options: AllPrintingsOptions = {}): Promise<ScryfallList<ScryfallCard>> {
  return request<ScryfallList<ScryfallCard>>(withQuery('/cards/search', {
    q: '* lang:en',
    page: options.page || 1,
    unique: 'prints',
    order: 'released',
    dir: 'asc',
    include_extras: true,
    include_multilingual: false,
    include_variations: true,
  }), { method: 'GET' }, options).then(englishCardList)
}

export async function* iterateAllPrintings(options: ScryfallRequestOptions = {}): AsyncGenerator<ScryfallCard[], void, void> {
  let nextPage: string | undefined = withQuery('/cards/search', {
    q: '* lang:en',
    page: 1,
    unique: 'prints',
    order: 'released',
    dir: 'asc',
    include_extras: true,
    include_multilingual: false,
    include_variations: true,
  })
  const visited = new Set<string>()

  while (nextPage) {
    if (visited.has(nextPage)) throw new Error(`Scryfall returned a pagination cycle at ${nextPage}`)
    visited.add(nextPage)
    const page = englishCardList(await request<ScryfallList<ScryfallCard>>(nextPage, { method: 'GET' }, options))
    yield page.data
    nextPage = page.has_more ? page.next_page : undefined
  }
}

export interface NamedCardOptions extends ScryfallRequestOptions {
  set?: string
}

export function getCardNamedFuzzy(name: string, options: NamedCardOptions = {}): Promise<ScryfallCard> {
  const trimmed = name.trim()
  if (!trimmed) return Promise.reject(new TypeError('A non-empty card name is required.'))
  return request(withQuery('/cards/named', { fuzzy: trimmed, set: options.set }), { method: 'GET' }, options)
}

export function getCardNamedExact(name: string, options: NamedCardOptions = {}): Promise<ScryfallCard> {
  const trimmed = name.trim()
  if (!trimmed) return Promise.reject(new TypeError('A non-empty card name is required.'))
  return request(withQuery('/cards/named', { exact: trimmed, set: options.set }), { method: 'GET' }, options)
}

export function getCardById(id: string, options: ScryfallRequestOptions = {}): Promise<ScryfallCard> {
  return request(`/cards/${encodeURIComponent(id)}`, { method: 'GET' }, options)
}

export type CardIdentifier =
  | { id: string }
  | { mtgo_id: number }
  | { multiverse_id: number }
  | { oracle_id: string }
  | { illustration_id: string }
  | { name: string; set?: string }
  | { collector_number: string; set: string }

export async function getCardCollection(identifiers: CardIdentifier[], options: ScryfallRequestOptions = {}): Promise<ScryfallCard[]> {
  const cards: ScryfallCard[] = []
  for (let offset = 0; offset < identifiers.length; offset += SCRYFALL_COLLECTION_LIMIT) {
    const batch = identifiers.slice(offset, offset + SCRYFALL_COLLECTION_LIMIT)
    const page = englishCardList(await request<ScryfallList<ScryfallCard>>('/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: batch }),
    }, options))
    cards.push(...page.data)
  }
  return cards
}

export function autocompleteCardNames(query: string, options: ScryfallRequestOptions = {}): Promise<string[]> {
  const trimmed = query.trim()
  if (!trimmed) return Promise.resolve([])
  return request<ScryfallList<string>>(withQuery('/cards/autocomplete', { q: trimmed, include_extras: true }), { method: 'GET' }, options)
    .then(validateListResponse)
    .then((response) => response.data)
}

export function getRandomCard(query?: string, options: ScryfallRequestOptions = {}): Promise<ScryfallCard> {
  return request(withQuery('/cards/random', { q: query?.trim() || undefined }), { method: 'GET' }, options)
}

export interface CatalogImportProgress {
  pages: number
  cards: number
  totalCards?: number
  resumed: boolean
  complete: boolean
}

export interface CatalogImportOptions extends ScryfallRequestOptions {
  resume?: boolean
  onProgress?: (progress: CatalogImportProgress) => void
}

interface CatalogMeta {
  key: 'import'
  nextPage?: string
  pages: number
  cards: number
  totalCards?: number
  updatedAt: number
  complete: boolean
}

const DATABASE_NAME = 'arcana-scryfall-catalog'
const DATABASE_VERSION = 1
const CARD_STORE = 'printings'
const META_STORE = 'metadata'
const memoryCatalog = new Map<string, ScryfallCard>()
let databasePromise: Promise<IDBDatabase> | undefined

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openCatalogDatabase(): Promise<IDBDatabase> {
  if (!supportsIndexedDb()) return Promise.reject(new Error('IndexedDB is not available in this environment.'))
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    open.onerror = () => reject(open.error || new Error('Unable to open the card catalog database.'))
    open.onblocked = () => reject(new Error('The card catalog database upgrade is blocked by another tab.'))
    open.onupgradeneeded = () => {
      const database = open.result
      if (!database.objectStoreNames.contains(CARD_STORE)) {
        const cards = database.createObjectStore(CARD_STORE, { keyPath: 'id' })
        cards.createIndex('oracle_id', 'oracle_id', { unique: false })
        cards.createIndex('name', 'name', { unique: false })
        cards.createIndex('released_at', 'released_at', { unique: false })
      }
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
    }
    open.onsuccess = () => resolve(open.result)
  })
  return databasePromise
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Catalog transaction failed.'))
    transaction.onabort = () => reject(transaction.error || new Error('Catalog transaction was aborted.'))
  })
}

function requestResult<T>(databaseRequest: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    databaseRequest.onsuccess = () => resolve(databaseRequest.result)
    databaseRequest.onerror = () => reject(databaseRequest.error || new Error('Catalog request failed.'))
  })
}

async function readImportMeta(): Promise<CatalogMeta | undefined> {
  if (!supportsIndexedDb()) return undefined
  const database = await openCatalogDatabase()
  const transaction = database.transaction(META_STORE, 'readonly')
  return requestResult(transaction.objectStore(META_STORE).get('import')) as Promise<CatalogMeta | undefined>
}

async function writeCatalogPage(cards: ScryfallCard[], meta: CatalogMeta): Promise<void> {
  const englishCards = cards.filter(isEnglishScryfallCard)
  englishCards.forEach((card) => memoryCatalog.set(card.id, card))
  if (!supportsIndexedDb()) return
  const database = await openCatalogDatabase()
  const transaction = database.transaction([CARD_STORE, META_STORE], 'readwrite')
  const store = transaction.objectStore(CARD_STORE)
  englishCards.forEach((card) => store.put(card))
  transaction.objectStore(META_STORE).put(meta)
  await transactionDone(transaction)
}

export async function clearCachedCatalog(): Promise<void> {
  memoryCatalog.clear()
  if (!supportsIndexedDb()) return
  const database = await openCatalogDatabase()
  const transaction = database.transaction([CARD_STORE, META_STORE], 'readwrite')
  transaction.objectStore(CARD_STORE).clear()
  transaction.objectStore(META_STORE).clear()
  await transactionDone(transaction)
}

export async function importAllPrintings(options: CatalogImportOptions = {}): Promise<CatalogImportProgress> {
  const previous = options.resume === false ? undefined : await readImportMeta().catch(() => undefined)
  if (options.resume === false) await clearCachedCatalog()
  let nextPage = previous?.complete ? undefined : previous?.nextPage
  if (!nextPage && !previous?.complete) {
    nextPage = withQuery('/cards/search', {
      q: '* lang:en',
      page: 1,
      unique: 'prints',
      order: 'released',
      dir: 'asc',
      include_extras: true,
      include_multilingual: false,
      include_variations: true,
    })
  }
  let pages = previous?.pages || 0
  let cards = previous?.cards || 0
  let totalCards = previous?.totalCards
  const resumed = Boolean(previous && pages > 0)

  if (previous?.complete) {
    const completeProgress = { pages, cards, totalCards, resumed: true, complete: true }
    options.onProgress?.(completeProgress)
    return completeProgress
  }

  const visited = new Set<string>()
  while (nextPage) {
    if (visited.has(nextPage)) throw new Error(`Scryfall returned a pagination cycle at ${nextPage}`)
    visited.add(nextPage)
    const response = englishCardList(await request<ScryfallList<ScryfallCard>>(nextPage, { method: 'GET' }, options))
    pages += 1
    cards += response.data.length
    totalCards = response.total_cards ?? totalCards
    const followingPage = response.has_more ? response.next_page : undefined
    const meta: CatalogMeta = {
      key: 'import',
      nextPage: followingPage,
      pages,
      cards,
      totalCards,
      updatedAt: Date.now(),
      complete: !response.has_more,
    }
    await writeCatalogPage(response.data, meta)
    nextPage = followingPage
    options.onProgress?.({ pages, cards, totalCards, resumed, complete: meta.complete })
  }

  return { pages, cards, totalCards, resumed, complete: true }
}

export async function getCachedCard(id: string): Promise<ScryfallCard | undefined> {
  const memoryCard = memoryCatalog.get(id)
  if (memoryCard) return isEnglishScryfallCard(memoryCard) ? memoryCard : undefined
  if (!supportsIndexedDb()) return undefined
  const database = await openCatalogDatabase()
  const transaction = database.transaction(CARD_STORE, 'readonly')
  const card = await requestResult(transaction.objectStore(CARD_STORE).get(id)) as ScryfallCard | undefined
  return card && isEnglishScryfallCard(card) ? card : undefined
}

export async function getCachedPrintingsByOracleId(oracleId: string): Promise<ScryfallCard[]> {
  if (!supportsIndexedDb()) return [...memoryCatalog.values()].filter((card) => isEnglishScryfallCard(card) && card.oracle_id === oracleId)
  const database = await openCatalogDatabase()
  const transaction = database.transaction(CARD_STORE, 'readonly')
  const cards = await requestResult(transaction.objectStore(CARD_STORE).index('oracle_id').getAll(oracleId)) as ScryfallCard[]
  return cards.filter(isEnglishScryfallCard)
}

export async function searchCachedCards(query: string, limit = 100): Promise<ScryfallCard[]> {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized || limit <= 0) return []
  if (!supportsIndexedDb()) {
    return [...memoryCatalog.values()].filter((card) => isEnglishScryfallCard(card) && card.name.toLocaleLowerCase().includes(normalized)).slice(0, limit)
  }
  const database = await openCatalogDatabase()
  const transaction = database.transaction(CARD_STORE, 'readonly')
  const store = transaction.objectStore(CARD_STORE)
  return new Promise((resolve, reject) => {
    const matches: ScryfallCard[] = []
    const cursor = store.openCursor()
    cursor.onerror = () => reject(cursor.error || new Error('Unable to search the cached catalog.'))
    cursor.onsuccess = () => {
      const current = cursor.result
      if (!current || matches.length >= limit) {
        resolve(matches)
        return
      }
      const card = current.value as ScryfallCard
      const faceText = card.card_faces?.map((face) => `${face.name} ${face.oracle_text || ''}`).join(' ') || ''
      if (isEnglishScryfallCard(card) && `${card.name} ${card.type_line} ${card.oracle_text || ''} ${faceText}`.toLocaleLowerCase().includes(normalized)) matches.push(card)
      current.continue()
    }
  })
}

export async function readCachedCatalog(): Promise<ScryfallCard[]> {
  if (!supportsIndexedDb()) return [...memoryCatalog.values()].filter(isEnglishScryfallCard)
  const database = await openCatalogDatabase()
  const transaction = database.transaction(CARD_STORE, 'readonly')
  const cards = await requestResult(transaction.objectStore(CARD_STORE).getAll()) as ScryfallCard[]
  return cards.filter(isEnglishScryfallCard)
}

export async function exportCachedCatalogJson(): Promise<Blob> {
  const cards = await readCachedCatalog()
  const metadata = await readImportMeta().catch(() => undefined)
  return new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), metadata, cards })], { type: 'application/json' })
}

export async function downloadCachedCatalog(filename = 'arcana-scryfall-printings.json'): Promise<void> {
  if (typeof document === 'undefined') throw new Error('Catalog downloads require a browser document.')
  const blob = await exportCachedCatalogJson()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export interface PaginatedCardsState {
  cards: ScryfallCard[]
  loading: boolean
  loadingMore: boolean
  error: Error | null
  hasMore: boolean
  totalCards?: number
  warnings: string[]
  loadMore: () => Promise<void>
  refresh: () => void
}

function usePaginatedScryfallCards(
  query: string,
  options: Omit<CardSearchOptions, 'signal' | 'page'> = {},
  endpoint: 'search' | 'all-printings' = 'search',
): PaginatedCardsState {
  const [cards, setCards] = useState<ScryfallCard[]>([])
  const [nextPage, setNextPage] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [totalCards, setTotalCards] = useState<number>()
  const [warnings, setWarnings] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const activeRequest = useRef<AbortController | undefined>(undefined)
  const trimmedQuery = query.trim()
  const stableOptions = useMemo(() => ({
    unique: options.unique,
    order: options.order,
    direction: options.direction,
    includeExtras: options.includeExtras,
    includeMultilingual: options.includeMultilingual,
    includeVariations: options.includeVariations,
    retries: options.retries,
  }), [options.unique, options.order, options.direction, options.includeExtras, options.includeMultilingual, options.includeVariations, options.retries])

  useEffect(() => {
    activeRequest.current?.abort()
    if (!trimmedQuery) {
      setCards([])
      setNextPage(undefined)
      setTotalCards(undefined)
      setWarnings([])
      setError(null)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    setError(null)
    const timeout = window.setTimeout(() => {
      const initialRequest = endpoint === 'all-printings'
        ? getPrintingsPage({ retries: stableOptions.retries, signal: controller.signal })
        : searchCards(trimmedQuery, { ...stableOptions, signal: controller.signal })
      initialRequest
        .then((response) => {
          setCards(response.data)
          setNextPage(response.next_page)
          setTotalCards(response.total_cards)
          setWarnings(response.warnings || [])
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason : new Error(String(reason)))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 250)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [endpoint, trimmedQuery, stableOptions, revision])

  const loadMore = useCallback(async () => {
    if (!nextPage || loadingMore) return
    const controller = new AbortController()
    activeRequest.current = controller
    setLoadingMore(true)
    setError(null)
    try {
      const response = englishCardList(await request<ScryfallList<ScryfallCard>>(nextPage, { method: 'GET' }, { signal: controller.signal, retries: stableOptions.retries }))
      setCards((current) => [...current, ...response.data])
      setNextPage(response.next_page)
      setTotalCards(response.total_cards)
      setWarnings((current) => [...current, ...(response.warnings || [])])
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason : new Error(String(reason)))
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false)
    }
  }, [loadingMore, nextPage, stableOptions.retries])

  return {
    cards,
    loading,
    loadingMore,
    error,
    hasMore: Boolean(nextPage),
    totalCards,
    warnings,
    loadMore,
    refresh: () => setRevision((current) => current + 1),
  }
}

export function useScryfallSearch(query: string, options: Omit<CardSearchOptions, 'signal' | 'page'> = {}): PaginatedCardsState {
  return usePaginatedScryfallCards(query, options)
}

export function useAllScryfallPrintings(options: Pick<CardSearchOptions, 'retries'> = {}): PaginatedCardsState {
  return usePaginatedScryfallCards('*', {
    unique: 'prints',
    order: 'released',
    direction: 'asc',
    includeExtras: true,
    includeMultilingual: false,
    includeVariations: true,
    retries: options.retries,
  }, 'all-printings')
}

export interface NamedCardState {
  card: ScryfallCard | null
  loading: boolean
  error: Error | null
}

export function useScryfallNamedFuzzy(name: string, set?: string): NamedCardState {
  const [state, setState] = useState<NamedCardState>({ card: null, loading: false, error: null })
  const trimmedName = name.trim()
  useEffect(() => {
    if (!trimmedName) {
      setState({ card: null, loading: false, error: null })
      return
    }
    const controller = new AbortController()
    setState((current) => ({ ...current, loading: true, error: null }))
    const timeout = window.setTimeout(() => {
      getCardNamedFuzzy(trimmedName, { set, signal: controller.signal })
        .then((card) => setState({ card, loading: false, error: null }))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setState({ card: null, loading: false, error: reason instanceof Error ? reason : new Error(String(reason)) })
        })
    }, 250)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [trimmedName, set])
  return state
}

export type EvergreenKeyword =
  | 'affinity'
  | 'banding'
  | 'battle-cry'
  | 'cascade'
  | 'changeling'
  | 'convoke'
  | 'cycling'
  | 'deathtouch'
  | 'defender'
  | 'delve'
  | 'double-strike'
  | 'enchant'
  | 'equip'
  | 'fear'
  | 'first-strike'
  | 'flash'
  | 'flying'
  | 'forestwalk'
  | 'haste'
  | 'hexproof'
  | 'indestructible'
  | 'intimidate'
  | 'islandwalk'
  | 'landwalk'
  | 'lifelink'
  | 'menace'
  | 'mountainwalk'
  | 'mutate'
  | 'partner'
  | 'phasing'
  | 'protection'
  | 'prowess'
  | 'reach'
  | 'shadow'
  | 'shroud'
  | 'skulk'
  | 'storm'
  | 'swampwalk'
  | 'toxic'
  | 'trample'
  | 'vigilance'
  | 'ward'

export type OracleTrigger =
  | 'static'
  | 'spell-resolution'
  | 'activated'
  | 'cast'
  | 'card-drawn'
  | 'life-gained'
  | 'enters'
  | 'leaves'
  | 'dies'
  | 'attacks'
  | 'blocks'
  | 'combat-damage'
  | 'begin-combat'
  | 'main-phase'
  | 'upkeep'
  | 'draw-step'
  | 'end-step'
  | 'replacement'

export type OracleTarget =
  | 'source'
  | 'you'
  | 'opponent'
  | 'target-player'
  | 'each-player'
  | 'target-creature'
  | 'target-permanent'
  | 'target-spell'
  | 'target-card'
  | 'all-creatures'
  | 'controlled-creature'
  | 'equipped-creature'
  | 'enchanted-object'
  | 'any-target'
  | 'unspecified'

export type OracleAmount =
  | number
  | 'X'
  | 'that-much'
  | 'source-power'
  | 'source-toughness'
  | 'mana-value'
  | 'life-total'
  | 'variable'

export interface OracleActionBase {
  id: string
  kind: string
  trigger: OracleTrigger
  target: OracleTarget
  condition?: string
  cost?: string
  optional: boolean
  sourceText: string
}

export type OracleAction =
  | (OracleActionBase & { kind: 'keyword'; keyword: EvergreenKeyword; value?: string })
  | (OracleActionBase & { kind: 'deal-damage'; amount: OracleAmount })
  | (OracleActionBase & { kind: 'gain-life' | 'lose-life' | 'draw-cards' | 'discard-cards' | 'mill-cards' | 'scry' | 'surveil'; amount: OracleAmount })
  | (OracleActionBase & { kind: 'add-mana'; mana: string[]; amount: OracleAmount })
  | (OracleActionBase & { kind: 'modify-stats'; power: OracleAmount; toughness: OracleAmount; duration: 'end-of-turn' | 'continuous' })
  | (OracleActionBase & { kind: 'destroy' | 'exile' | 'tap' | 'untap' | 'sacrifice' | 'counter-spell' })
  | (OracleActionBase & { kind: 'create-token'; amount: OracleAmount; token: string; tapped: boolean; attacking: boolean })
  | (OracleActionBase & { kind: 'put-counters' | 'remove-counters'; amount: OracleAmount; counter: string })
  | (OracleActionBase & { kind: 'return-to-zone'; zone: 'hand' | 'battlefield' | 'library' | 'graveyard'; placement?: 'top' | 'bottom' })
  | (OracleActionBase & { kind: 'search-library'; cardConstraint: string; destination: 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'library'; tapped: boolean })
  | (OracleActionBase & { kind: 'extra-turn'; amount: OracleAmount })
  | (OracleActionBase & { kind: 'additional-land-play'; amount: OracleAmount })
  | (OracleActionBase & { kind: 'prevent-damage'; amount: OracleAmount })
  | (OracleActionBase & { kind: 'copy'; object: 'spell' | 'permanent' | 'card' | 'ability' })
  | (OracleActionBase & { kind: 'unparsed'; clause: string })

export interface ParsedOracleText {
  source: string
  keywords: EvergreenKeyword[]
  actions: OracleAction[]
  unsupportedClauses: string[]
}

const KEYWORD_PATTERNS: ReadonlyArray<[EvergreenKeyword, RegExp]> = [
  ['double-strike', /\bdouble strike\b/i],
  ['first-strike', /\bfirst strike\b/i],
  ['battle-cry', /\bbattle cry\b/i],
  ['forestwalk', /\bforestwalk\b/i],
  ['islandwalk', /\bislandwalk\b/i],
  ['mountainwalk', /\bmountainwalk\b/i],
  ['swampwalk', /\bswampwalk\b/i],
  ['deathtouch', /\bdeathtouch\b/i],
  ['defender', /\bdefender\b/i],
  ['flash', /\bflash\b/i],
  ['flying', /\bflying\b/i],
  ['haste', /\bhaste\b/i],
  ['hexproof', /\bhexproof\b/i],
  ['indestructible', /\bindestructible\b/i],
  ['lifelink', /\blifelink\b/i],
  ['menace', /\bmenace\b/i],
  ['protection', /\bprotection from\b/i],
  ['prowess', /\bprowess\b/i],
  ['reach', /\breach\b/i],
  ['shroud', /\bshroud\b/i],
  ['trample', /\btrample\b/i],
  ['vigilance', /\bvigilance\b/i],
  ['ward', /\bward\b/i],
  ['affinity', /\baffinity for\b/i],
  ['banding', /\bbanding\b/i],
  ['cascade', /\bcascade\b/i],
  ['changeling', /\bchangeling\b/i],
  ['convoke', /\bconvoke\b/i],
  ['cycling', /\b(?:basic land|type|wizard|island|plains|swamp|mountain|forest)?cycling\b/i],
  ['delve', /\bdelve\b/i],
  ['enchant', /\benchant\s+\w/i],
  ['equip', /\bequip\s*(?:\{|$)/i],
  ['fear', /\bfear\b/i],
  ['intimidate', /\bintimidate\b/i],
  ['landwalk', /\blandwalk\b/i],
  ['mutate', /\bmutate\b/i],
  ['partner', /\bpartner(?: with)?\b/i],
  ['phasing', /\bphasing\b/i],
  ['shadow', /\bshadow\b/i],
  ['skulk', /\bskulk\b/i],
  ['storm', /\bstorm\b/i],
  ['toxic', /\btoxic\s+\d+\b/i],
]

function amountFrom(value: string | undefined, fallback: OracleAmount = 1): OracleAmount {
  if (!value) return fallback
  const normalized = value.trim().toLocaleLowerCase().replace(/^equal to\s+/, '')
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  if (normalized in words) return words[normalized]
  if (normalized === 'x') return 'X'
  if (/^that (?:much|many|number)$/.test(normalized)) return 'that-much'
  if (/^(?:its|this permanent's|this creature's|that creature's) power$/.test(normalized)) return 'source-power'
  if (/^(?:its|this permanent's|this creature's|that creature's) toughness$/.test(normalized)) return 'source-toughness'
  if (/^(?:its|that card's|that spell's) mana value$/.test(normalized)) return 'mana-value'
  if (/^(?:your|their|that player's) life total$/.test(normalized)) return 'life-total'
  const number = Number(normalized)
  return Number.isFinite(number) ? number : 'variable'
}

function inferTarget(text: string): OracleTarget {
  const normalized = text.toLocaleLowerCase()
  if (/\bany target\b/.test(normalized)) return 'any-target'
  if (/\btarget (?:creature|creature card)(?:\s+or\s+planeswalker)?\b/.test(normalized)) return 'target-creature'
  if (/\btarget (?:permanent|artifact|enchantment|planeswalker|battle|land)(?:\s+or\s+\w+)?\b/.test(normalized)) return 'target-permanent'
  if (/\btarget (?:\w+\s+)*spell\b/.test(normalized)) return 'target-spell'
  if (/\btarget (?:card|cards)\b/.test(normalized)) return 'target-card'
  if (/\btarget player\b/.test(normalized)) return 'target-player'
  if (/\b(?:an|each|target) opponent\b|\bopponent's\b/.test(normalized)) return 'opponent'
  if (/\beach player\b/.test(normalized)) return 'each-player'
  if (/\b(?:a |another )?creatures? you control\b/.test(normalized)) return 'controlled-creature'
  if (/\ball creatures\b|\beach creature\b|\bcreatures your opponents control\b/.test(normalized)) return 'all-creatures'
  if (/\bequipped creature\b/.test(normalized)) return 'equipped-creature'
  if (/\benchanted (?:creature|permanent|player)\b/.test(normalized)) return 'enchanted-object'
  if (/\b(?:its controller|that player)\b/.test(normalized)) return 'target-player'
  if (/\byou\b/.test(normalized)) return 'you'
  if (/\b(?:this creature|this permanent|it)\b/.test(normalized)) return 'source'
  return 'unspecified'
}

function triggerFrom(line: string, defaultTrigger: OracleTrigger): { trigger: OracleTrigger; body: string; condition?: string; cost?: string } {
  const trimmed = line.trim().replace(/^[^\n—]+—\s*(?=(?:when|whenever|at)\b)/i, '')
  const activatedColon = trimmed.indexOf(':')
  if (activatedColon >= 0) {
    return { trigger: 'activated', cost: trimmed.slice(0, activatedColon).trim(), body: trimmed.slice(activatedColon + 1).trim() }
  }
  const triggered = trimmed.match(/^(when|whenever|at)\s+(.+?),\s*(.+)$/i)
  if (triggered) {
    const event = triggered[2].toLocaleLowerCase()
    let trigger: OracleTrigger = 'static'
    if (/\bcast\b/.test(event)) trigger = 'cast'
    else if (/\b(?:draw|draws|drew)\b/.test(event) && !/draw step/.test(event)) trigger = 'card-drawn'
    else if (/\bgain(?:s|ed)? life\b/.test(event)) trigger = 'life-gained'
    else if (/\benters?\b/.test(event)) trigger = 'enters'
    else if (/\bleaves?\b/.test(event)) trigger = 'leaves'
    else if (/\bdies\b/.test(event)) trigger = 'dies'
    else if (/\battacks?\b/.test(event)) trigger = 'attacks'
    else if (/\bblocks?\b|becomes blocked/.test(event)) trigger = 'blocks'
    else if (/combat damage/.test(event)) trigger = 'combat-damage'
    else if (/beginning of combat/.test(event)) trigger = 'begin-combat'
    else if (/(?:precombat |postcombat |first |second )?main phase/.test(event)) trigger = 'main-phase'
    else if (/upkeep/.test(event)) trigger = 'upkeep'
    else if (/draw step/.test(event)) trigger = 'draw-step'
    else if (/end step/.test(event)) trigger = 'end-step'
    return { trigger, condition: triggered[2].trim(), body: triggered[3].trim() }
  }
  if (/\binstead\b/i.test(trimmed)) return { trigger: 'replacement', body: trimmed }
  return { trigger: defaultTrigger, body: trimmed }
}

function actionBase(index: number, sourceText: string, trigger: OracleTrigger, target: OracleTarget, optional: boolean, condition?: string, cost?: string): OracleActionBase {
  return { id: `oracle-${index}`, kind: 'unparsed', sourceText, trigger, target, optional, condition, cost }
}

function manaSymbols(text: string): string[] {
  return [...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1].toLocaleUpperCase())
}

function splitOracleClauses(oracleText: string): string[] {
  return oracleText
    .replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function splitEffectClauses(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|;\s*/)
    .map((clause) => clause.trim().replace(/^[•]\s*/, ''))
    .filter(Boolean)
}

function conditionalClause(clause: string, inheritedCondition?: string): { body: string; condition?: string } {
  const conditional = clause.match(/^(if|unless)\s+(.+?),\s*(.+)$/i)
  if (!conditional) return { body: clause, condition: inheritedCondition }
  const localCondition = `${conditional[1].toLocaleLowerCase()} ${conditional[2].trim()}`
  return {
    body: conditional[3].trim(),
    condition: inheritedCondition ? `${inheritedCondition}; ${localCondition}` : localCondition,
  }
}

function keywordValue(keyword: EvergreenKeyword, text: string): string | undefined {
  if (keyword === 'ward') return text.match(/\bward\s+([^.,;]+)/i)?.[1]?.trim()
  if (keyword === 'equip') return text.match(/\bequip\s+([^.,;]+)/i)?.[1]?.trim()
  if (keyword === 'enchant') return text.match(/\benchant\s+([^.,;]+)/i)?.[1]?.trim()
  if (keyword === 'protection') return text.match(/\bprotection from\s+([^.,;]+)/i)?.[1]?.trim()
  if (keyword === 'toxic') return text.match(/\btoxic\s+(\d+)/i)?.[1]
  if (keyword === 'cycling') return text.match(/\bcycling\s+([^.,;]+)/i)?.[1]?.trim()
  return undefined
}

type OracleActionInput<T extends OracleAction = OracleAction> = T extends OracleAction
  ? Omit<T, keyof OracleActionBase> & Pick<T, 'kind'> & { target?: OracleTarget }
  : never

function appendMatchedActions(
  actions: OracleAction[],
  line: string,
  body: string,
  trigger: OracleTrigger,
  condition: string | undefined,
  cost: string | undefined,
  nextId: () => number,
): number {
  const optional = /\byou may\b/i.test(body)
  const target = inferTarget(body)
  let matches = 0
  const add = (action: OracleActionInput) => {
    const base = actionBase(nextId(), line, trigger, action.target || target, optional, condition, cost)
    actions.push({ ...base, ...action } as OracleAction)
    matches += 1
  }

  for (const match of body.matchAll(/\bdeals?\s+(\d+|X|that much)\s+damage\s+to\s+([^.;]+)/gi)) {
    add({ kind: 'deal-damage', amount: amountFrom(match[1]), target: inferTarget(match[2]) })
  }
  for (const match of body.matchAll(/\bdeals?\s+damage\s+equal\s+to\s+(.+?)\s+to\s+([^.;]+)/gi)) {
    add({ kind: 'deal-damage', amount: amountFrom(`equal to ${match[1]}`), target: inferTarget(match[2]) })
  }
  for (const match of body.matchAll(/\b(?:you|target player|its controller|that player)\s+gains?\s+(\d+|X|that much)\s+life\b/gi)) {
    add({ kind: 'gain-life', amount: amountFrom(match[1]), target: inferTarget(match[0]) })
  }
  for (const match of body.matchAll(/\b(?:you|target player|its controller|that player)\s+gains?\s+life\s+equal\s+to\s+([^.;]+)/gi)) {
    add({ kind: 'gain-life', amount: amountFrom(`equal to ${match[1]}`), target: inferTarget(match[0]) })
  }
  for (const match of body.matchAll(/\b(?:you|target player|each opponent|an opponent)\s+loses?\s+(\d+|X|that much)\s+life\b/gi)) {
    add({ kind: 'lose-life', amount: amountFrom(match[1]), target: inferTarget(match[0]) })
  }
  for (const match of body.matchAll(/\b(?:you|target player|each opponent|an opponent|target opponent)\s+loses?\s+life\s+equal\s+to\s+([^.;]+)/gi)) {
    add({ kind: 'lose-life', amount: amountFrom(`equal to ${match[1]}`), target: inferTarget(match[0]) })
  }
  for (const match of body.matchAll(/\bdraw\s+(a|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X|that many)\s+cards?\b/gi)) {
    const drawTarget = inferTarget(body.slice(0, match.index))
    add({ kind: 'draw-cards', amount: amountFrom(match[1] === 'that many' ? 'that much' : match[1]), target: drawTarget === 'unspecified' ? 'you' : drawTarget })
  }
  for (const match of body.matchAll(/\bdraw\s+cards?\s+equal\s+to\s+([^.;]+)/gi)) {
    const drawTarget = inferTarget(body.slice(0, match.index))
    add({ kind: 'draw-cards', amount: amountFrom(`equal to ${match[1]}`), target: drawTarget === 'unspecified' ? 'you' : drawTarget })
  }
  for (const match of body.matchAll(/\bdiscards?\s+(a|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X|that many)\s+cards?\b/gi)) {
    add({ kind: 'discard-cards', amount: amountFrom(match[1] === 'that many' ? 'that much' : match[1]) })
  }
  for (const match of body.matchAll(/\bmills?\s+(a|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X|that many)\s+cards?\b/gi)) {
    add({ kind: 'mill-cards', amount: amountFrom(match[1] === 'that many' ? 'that much' : match[1]) })
  }
  for (const match of body.matchAll(/\bmills?\s+(?:cards?\s+equal\s+to\s+|half of\s+)([^.;]+)/gi)) {
    add({ kind: 'mill-cards', amount: amountFrom(`equal to ${match[1]}`) })
  }
  for (const match of body.matchAll(/\b(scry|surveil)\s+(\d+|X)\b/gi)) {
    const kind = match[1].toLocaleLowerCase() as 'scry' | 'surveil'
    add({ kind, amount: amountFrom(match[2]), target: 'you' })
  }
  for (const match of body.matchAll(/\badd\s+((?:\{[^}]+\}(?:\s+or\s+|,?\s*)?)+)/gi)) {
    const mana = manaSymbols(match[1])
    add({ kind: 'add-mana', mana, amount: mana.length || 1, target: 'you' })
  }
  for (const match of body.matchAll(/\badd\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+|X)\s+mana\s+of\s+any(?: one)?\s+color\b/gi)) {
    add({ kind: 'add-mana', mana: ['ANY'], amount: amountFrom(match[1]), target: 'you' })
  }
  for (const match of body.matchAll(/\bgets?\s+([+\-\u2212]?\d+|[+\-\u2212]?X)\/([+\-\u2212]?\d+|[+\-\u2212]?X)(?:\s+until end of turn)?/gi)) {
    const parseStat = (value: string): OracleAmount => value.toLocaleUpperCase().includes('X') ? 'X' : Number(value.replace('\u2212', '-'))
    add({
      kind: 'modify-stats',
      power: parseStat(match[1]),
      toughness: parseStat(match[2]),
      duration: /until end of turn/i.test(match[0]) ? 'end-of-turn' : 'continuous',
    })
  }
  for (const [kind, pattern] of [
    ['destroy', /\bdestroy\s+([^.;]+)/gi],
    ['exile', /\bexile\s+([^.;]+)/gi],
    ['tap', /(?<!un)\btap\s+([^.;]+)/gi],
    ['untap', /\buntap\s+([^.;]+)/gi],
    ['sacrifice', /\bsacrifice\s+([^.;]+)/gi],
    ['counter-spell', /\bcounter\s+target\s+(?:\w+\s+)*spell\b/gi],
  ] as const) {
    for (const match of body.matchAll(pattern)) {
      add({ kind, target: inferTarget(match[0]) })
    }
  }
  for (const match of body.matchAll(/\bcreate\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X|that many)\s+([^.;]+?)\s+tokens?\b([^.;]*)/gi)) {
    add({
      kind: 'create-token',
      amount: amountFrom(match[1] === 'that many' ? 'that much' : match[1]),
      token: match[2].trim(),
      tapped: /\btapped\b/i.test(match[3]),
      attacking: /\battacking\b/i.test(match[3]),
      target: 'you',
    })
  }
  for (const match of body.matchAll(/\bput\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X|that many)\s+([+\-\u2212]\d+\/[+\-\u2212]\d+|[\w-]+)\s+counters?\s+on\s+([^.;]+)/gi)) {
    add({ kind: 'put-counters', amount: amountFrom(match[1] === 'that many' ? 'that much' : match[1]), counter: match[2].replace('\u2212', '-'), target: inferTarget(match[3]) })
  }
  for (const match of body.matchAll(/\bremove\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X|that many|all)\s+([+\-\u2212]\d+\/[+\-\u2212]\d+|[\w-]+)\s+counters?\s+from\s+([^.;]+)/gi)) {
    add({ kind: 'remove-counters', amount: amountFrom(match[1] === 'that many' ? 'that much' : match[1] === 'all' ? 'variable' : match[1]), counter: match[2].replace('\u2212', '-'), target: inferTarget(match[3]) })
  }
  for (const match of body.matchAll(/\breturn\s+([^.;]+?)\s+to\s+(?:its|their|the)\s+owner'?s?\s+(hand|graveyard)|\breturn\s+([^.;]+?)\s+to\s+the\s+battlefield/gi)) {
    const zone = (match[2]?.toLocaleLowerCase() || 'battlefield') as 'hand' | 'battlefield' | 'graveyard'
    add({ kind: 'return-to-zone', zone, target: inferTarget(match[1] || match[3]) })
  }
  for (const match of body.matchAll(/\breturn\s+([^.;]+?)\s+from\s+(?:a|the|your|target player's)\s+graveyard\s+to\s+(?:its owner'?s?|your|their)\s+(hand|battlefield)/gi)) {
    add({ kind: 'return-to-zone', zone: match[2].toLocaleLowerCase() as 'hand' | 'battlefield', target: inferTarget(match[1]) })
  }
  for (const match of body.matchAll(/\bput\s+([^.;]+?)\s+on\s+(?:the\s+)?(top|bottom)\s+of\s+(?:its|their|your)\s+owner'?s?\s+library/gi)) {
    add({ kind: 'return-to-zone', zone: 'library', placement: match[2].toLocaleLowerCase() as 'top' | 'bottom', target: inferTarget(match[1]) })
  }
  for (const match of body.matchAll(/\bsearch your library for\s+(.+?)(?=(?:,\s*|\s+and\s+)(?:reveal|put|exile|then)|[.;]|$)([^.;]*)/gi)) {
    const remainder = match[2]
    const destination = /(?:onto|on) the battlefield/i.test(remainder)
      ? 'battlefield'
      : /into your graveyard/i.test(remainder)
        ? 'graveyard'
        : /\bexile\b/i.test(remainder)
          ? 'exile'
          : /(?:top|bottom) of (?:your|the) library/i.test(remainder)
            ? 'library'
            : 'hand'
    add({ kind: 'search-library', cardConstraint: match[1].trim(), destination, tapped: /\btapped\b/i.test(remainder), target: 'you' })
  }
  for (const match of body.matchAll(/\b(?:take|takes)\s+(an|one|\d+|X)\s+extra turns?\b/gi)) {
    add({ kind: 'extra-turn', amount: amountFrom(match[1]), target: inferTarget(body) })
  }
  for (const match of body.matchAll(/\bplay\s+(an|one|\d+)\s+additional lands?\b/gi)) {
    add({ kind: 'additional-land-play', amount: amountFrom(match[1]), target: 'you' })
  }
  for (const match of body.matchAll(/\bprevent\s+(the next\s+)?(\d+|X|all)\s+damage\b/gi)) {
    add({ kind: 'prevent-damage', amount: match[2].toLocaleLowerCase() === 'all' ? 'variable' : amountFrom(match[2]) })
  }
  for (const match of body.matchAll(/\bcopy\s+(target\s+)?(spell|permanent|card|activated or triggered ability|ability)\b/gi)) {
    const object = match[2].toLocaleLowerCase().includes('ability') ? 'ability' : match[2].toLocaleLowerCase() as 'spell' | 'permanent' | 'card'
    add({ kind: 'copy', object })
  }

  return matches
}

export function parseOracleText(oracleText: string, cardName = '', defaultTrigger: OracleTrigger = 'spell-resolution'): ParsedOracleText {
  const source = oracleText.trim()
  const escapedName = cardName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const normalizedSource = escapedName
    ? source.replace(new RegExp(escapedName, 'gi'), 'this permanent')
    : source
  const lines = splitOracleClauses(normalizedSource)
  const actions: OracleAction[] = []
  const keywordSet = new Set<EvergreenKeyword>()
  const unsupportedClauses: string[] = []
  let actionIndex = 0
  const nextId = () => {
    actionIndex += 1
    return actionIndex
  }

  for (const line of lines) {
    const context = triggerFrom(line, defaultTrigger)
    for (const clause of splitEffectClauses(context.body)) {
      const local = conditionalClause(clause, context.condition)
      const target = inferTarget(local.body)
      let matched = appendMatchedActions(actions, line, local.body, context.trigger, local.condition, context.cost, nextId)

      const keywordAbilityLine = KEYWORD_PATTERNS.some(([, pattern]) => local.body.search(pattern) === 0)
      for (const [keyword, pattern] of KEYWORD_PATTERNS) {
        if (!pattern.test(local.body)) continue
        const isGranted = /\b(?:has|have|gains?|gain)\b/i.test(local.body)
        if (!isGranted && !keywordAbilityLine && context.trigger !== 'static') continue
        keywordSet.add(keyword)
        const base = actionBase(nextId(), line, context.trigger === 'spell-resolution' && keywordAbilityLine ? 'static' : context.trigger, target === 'unspecified' ? 'source' : target, /\byou may\b/i.test(local.body), local.condition, context.cost)
        actions.push({ ...base, kind: 'keyword', keyword, value: keywordValue(keyword, local.body) })
        matched += 1
      }

      if (matched === 0) {
        unsupportedClauses.push(clause)
        const base = actionBase(nextId(), line, context.trigger, target, /\byou may\b/i.test(local.body), local.condition, context.cost)
        actions.push({ ...base, kind: 'unparsed', clause: local.body })
      }
    }
  }

  return { source, keywords: [...keywordSet], actions, unsupportedClauses }
}

export function parseScryfallCard(card: ScryfallCard): Record<string, ParsedOracleText> {
  if (card.card_faces?.length) {
    return Object.fromEntries(card.card_faces.map((face) => {
      const defaultTrigger: OracleTrigger = /\b(?:Instant|Sorcery)\b/.test(face.type_line) ? 'spell-resolution' : 'static'
      return [face.name, parseOracleText(face.oracle_text || '', face.name, defaultTrigger)]
    }))
  }
  const defaultTrigger: OracleTrigger = /\b(?:Instant|Sorcery)\b/.test(card.type_line) ? 'spell-resolution' : 'static'
  return { [card.name]: parseOracleText(card.oracle_text || '', card.name, defaultTrigger) }
}

export interface ArcanaCatalogCard {
  id: string
  oracleId?: string
  name: string
  image: string
  manaCost: string
  manaValue: number
  typeLine: string
  oracleText: string
  colors: ScryfallColor[]
  colorIdentity: ScryfallColor[]
  set: string
  setName: string
  collectorNumber: string
  rarity: ScryfallCard['rarity']
  releasedAt: string
  power?: string
  toughness?: string
  loyalty?: string
  defense?: string
  legalities: ScryfallCard['legalities']
  rules: Record<string, ParsedOracleText>
  source: ScryfallCard
}

export function toArcanaCatalogCard(card: ScryfallCard): ArcanaCatalogCard {
  const front = card.card_faces?.[0]
  return {
    id: card.id,
    oracleId: card.oracle_id,
    name: card.name,
    image: card.image_uris?.normal || front?.image_uris?.normal || '',
    manaCost: card.mana_cost || front?.mana_cost || '',
    manaValue: card.cmc,
    typeLine: card.type_line || front?.type_line || '',
    oracleText: card.oracle_text || card.card_faces?.map((face) => face.oracle_text || '').filter(Boolean).join('\n//\n') || '',
    colors: card.colors || front?.colors || [],
    colorIdentity: card.color_identity,
    set: card.set,
    setName: card.set_name,
    collectorNumber: card.collector_number,
    rarity: card.rarity,
    releasedAt: card.released_at,
    power: card.power || front?.power,
    toughness: card.toughness || front?.toughness,
    loyalty: card.loyalty || front?.loyalty,
    defense: card.defense || front?.defense,
    legalities: card.legalities,
    rules: parseScryfallCard(card),
    source: card,
  }
}
