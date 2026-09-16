import { AnimatePresence, motion } from 'framer-motion'
import { LibraryBig, LoaderCircle, Plus, ShoppingBag, Sparkles, Swords } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Lobby } from './Lobby'
import { LobbyCinematicIntro } from './components/LobbyCinematicIntro'
import {
  loadDecks,
  persistDecks,
  resolveDeckCard,
  starterDeck,
  type SavedDeck,
} from './catalog'
import {
  loadCloudDecks,
  mergeDeckCollections,
  syncCloudDecks,
  type DeckSyncStatus,
} from './services/deckRepository'
import { isSupabaseConfigured } from './services/supabase'

const DeckBuilder = lazy(() => import('./DeckBuilder').then((module) => ({ default: module.DeckBuilder })))
const OnlineMatch = lazy(() => import('./OnlineMatch').then((module) => ({ default: module.OnlineMatch })))
const PracticeMatch = lazy(() => import('./practice/PracticeMatch').then((module) => ({ default: module.PracticeMatch })))
const Shop = lazy(() => import('./Shop').then((module) => ({ default: module.Shop })))

type Page = 'lobby' | 'decks' | 'builder' | 'shop' | 'practice' | 'online'

function RouteLoading() {
  return <div className="route-loading" role="status"><LoaderCircle /><span>Preparing table</span></div>
}

function App() {
  const [page, setPage] = useState<Page>('lobby')
  const [decks, setDecks] = useState<SavedDeck[]>(loadDecks)
  const [editingDeckId, setEditingDeckId] = useState<string | undefined>()
  const [onlineRoom, setOnlineRoom] = useState('')
  const [practiceDeck, setPracticeDeck] = useState<SavedDeck>(() => loadDecks()[0] || starterDeck())
  const [cloudDecksLoaded, setCloudDecksLoaded] = useState(false)
  const [deckSyncStatus, setDeckSyncStatus] = useState<DeckSyncStatus>(isSupabaseConfigured ? 'syncing' : 'local')
  const [showLobbyIntro, setShowLobbyIntro] = useState(true)

  useEffect(() => persistDecks(decks), [decks])

  useEffect(() => {
    if (!isSupabaseConfigured) return
    let active = true
    setDeckSyncStatus('syncing')
    void loadCloudDecks()
      .then((remoteDecks) => {
        if (!active) return
        setDecks((localDecks) => mergeDeckCollections(localDecks, remoteDecks))
        setCloudDecksLoaded(true)
        setDeckSyncStatus('synced')
      })
      .catch((error: unknown) => {
        if (!active) return
        console.error('Cloud deck loading failed', error)
        setDeckSyncStatus('error')
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured || !cloudDecksLoaded) return
    setDeckSyncStatus('syncing')
    const timeout = window.setTimeout(() => {
      void syncCloudDecks(decks)
        .then(() => setDeckSyncStatus('synced'))
        .catch((error: unknown) => {
          console.error('Cloud deck synchronization failed', error)
          setDeckSyncStatus('error')
        })
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [cloudDecksLoaded, decks])

  const openBuilder = (deckId?: string) => {
    setEditingDeckId(deckId)
    setPage('builder')
  }

  const newDeck = () => {
    const deck = starterDeck()
    deck.id = `deck-${Date.now()}`
    deck.name = 'Untitled Deck'
    deck.entries = []
    deck.sideboard = []
    setDecks((items) => [...items, deck])
    openBuilder(deck.id)
  }

  if (page === 'practice') return <Suspense fallback={<RouteLoading />}><PracticeMatch deck={practiceDeck} onExit={() => setPage('lobby')} /></Suspense>
  if (page === 'online') return <Suspense fallback={<RouteLoading />}><OnlineMatch roomId={onlineRoom} onExit={() => setPage('lobby')} /></Suspense>

  return (
    <div className="hub-shell">
      <header className="hub-header">
        <button type="button" className="hub-brand" onClick={() => setPage('lobby')}><span><Sparkles /></span><b>ARCANA</b><small>DUEL</small></button>
        <nav><button type="button" className={page === 'lobby' ? 'active' : ''} onClick={() => setPage('lobby')}><Swords /> Play</button><button type="button" className={page === 'decks' || page === 'builder' ? 'active' : ''} onClick={() => setPage('decks')}><LibraryBig /> Decks</button><button type="button" className={page === 'shop' ? 'active' : ''} onClick={() => setPage('shop')}><ShoppingBag /> Shop</button></nav>
        <div className="hub-profile"><span><img src="/cards/questing-beast.jpg" alt="" /></span><div><b>PLANESWALKER</b></div></div>
      </header>
      <Suspense fallback={<RouteLoading />}>
        <AnimatePresence mode="wait">
          {page === 'lobby' && <Lobby key="lobby" decks={decks} onEditDeck={openBuilder} onPractice={(deck) => { setPracticeDeck(deck); setPage('practice') }} onMatch={(roomId) => { setOnlineRoom(roomId); setPage('online') }} />}
          {page === 'builder' && <DeckBuilder key="builder" decks={decks} setDecks={setDecks} syncStatus={deckSyncStatus} initialDeckId={editingDeckId} onBack={() => setPage('decks')} />}
          {page === 'shop' && <Shop key="shop" />}
          {page === 'decks' && (
            <motion.main key="decks" className="decks-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="decks-heading"><div><span>Collection</span><h1>Your decks</h1><p>Build, tune, and choose what you bring to the table.</p></div><button type="button" onClick={newDeck}><span><Plus /></span> New deck</button></div>
              <div className="deck-gallery">
                {decks.map((deck, index) => {
                  const coverEntry = deck.entries.find((entry) => !['forest', 'mountain'].includes(entry.cardId))
                  const cover = coverEntry ? resolveDeckCard(coverEntry)?.image : '/cards/questing-beast.jpg'
                  return <motion.button type="button" key={deck.id} className="deck-tile" onClick={() => openBuilder(deck.id)} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .06 }} whileHover={{ y: -6 }}><div className="deck-cover"><img src={cover} alt="" /><span className="cover-fade" /><i /><i /></div><div className="deck-tile-info"><span><b>{deck.name}</b><small>{deck.format}</small></span><strong>{deck.entries.reduce((sum, entry) => sum + entry.quantity, 0)}<small>cards</small></strong></div></motion.button>
                })}
                <button type="button" className="deck-tile add-deck" onClick={newDeck}><span><Plus /></span><b>Create a deck</b><small>Start with an empty list</small></button>
              </div>
            </motion.main>
          )}
        </AnimatePresence>
      </Suspense>
      {page === 'lobby' && <LobbyCinematicIntro active={showLobbyIntro} onComplete={() => setShowLobbyIntro(false)} />}
    </div>
  )
}

export default App
