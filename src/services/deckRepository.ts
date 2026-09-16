import { sanitizeDeckEntries, type SavedDeck } from '../catalog'
import { evaluateDeckLegality } from '../deckLegality'
import { ensureAnonymousSession, requireSupabase } from './supabase'

export type DeckSyncStatus = 'local' | 'syncing' | 'synced' | 'error'

type StoredDeckRow = {
  id: string
  owner_id: string
  client_key: string
  name: string
  format: string
  mainboard: unknown
  sideboard: unknown
  is_legal: boolean
  client_updated_at: string
}

function rowToDeck(row: StoredDeckRow): SavedDeck {
  return {
    id: row.client_key,
    name: row.name,
    format: row.format,
    updatedAt: Date.parse(row.client_updated_at) || Date.now(),
    entries: sanitizeDeckEntries(row.mainboard),
    sideboard: sanitizeDeckEntries(row.sideboard),
  }
}

function isDeckLegal(deck: SavedDeck): boolean {
  return evaluateDeckLegality(deck).legal
}

export function mergeDeckCollections(local: SavedDeck[], remote: SavedDeck[]): SavedDeck[] {
  const merged = new Map<string, SavedDeck>()
  for (const deck of [...local, ...remote]) {
    const current = merged.get(deck.id)
    if (!current || deck.updatedAt > current.updatedAt) merged.set(deck.id, deck)
  }
  return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function loadCloudDecks(): Promise<SavedDeck[]> {
  const session = await ensureAnonymousSession()
  const client = requireSupabase()
  const { data, error } = await client
    .from('stored_decks')
    .select('id, owner_id, client_key, name, format, mainboard, sideboard, is_legal, client_updated_at')
    .eq('owner_id', session.user.id)
    .order('client_updated_at', { ascending: false })
  if (error) throw error
  return (data as StoredDeckRow[]).map(rowToDeck)
}

export async function syncCloudDecks(decks: SavedDeck[]): Promise<void> {
  const session = await ensureAnonymousSession()
  const client = requireSupabase()
  const ownerId = session.user.id
  const { data: existing, error: readError } = await client
    .from('stored_decks')
    .select('id, client_key')
    .eq('owner_id', ownerId)
  if (readError) throw readError

  if (decks.length) {
    const rows = decks.map((deck) => ({
      owner_id: ownerId,
      client_key: deck.id.slice(0, 160),
      name: deck.name.slice(0, 80) || 'Untitled Deck',
      format: deck.format.slice(0, 32) || 'Casual',
      mainboard: deck.entries,
      sideboard: deck.sideboard,
      is_legal: isDeckLegal(deck),
      client_updated_at: new Date(deck.updatedAt).toISOString(),
    }))
    const { error } = await client
      .from('stored_decks')
      .upsert(rows, { onConflict: 'owner_id,client_key' })
    if (error) throw error
  }

  const retained = new Set(decks.map((deck) => deck.id.slice(0, 160)))
  const obsoleteIds = (existing as Array<{ id: string; client_key: string }> | null ?? [])
    .filter((row) => !retained.has(row.client_key))
    .map((row) => row.id)
  if (obsoleteIds.length) {
    const { error } = await client.from('stored_decks').delete().in('id', obsoleteIds)
    if (error) throw error
  }
}
