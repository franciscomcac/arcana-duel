import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  Gamepad2,
  Globe2,
  Lock,
  Plus,
  Radio,
  Search,
  Swords,
  UserRound,
  UsersRound,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { expandDeckCards, resolveDeckCard, type SavedDeck } from './catalog'
import { socket } from './socket'
import { isSupabaseConfigured } from './services/supabase'
import {
  createCloudRoom,
  fetchCloudLobby,
  findCloudQuickMatch,
  getCloudUserId,
  joinCloudRoom,
  leaveCloudRoom,
  setCloudRoomReady,
  subscribeToCloudLobby,
} from './services/cloudMatch'
import { snapshotToCloudRoom } from './services/cloudMatchModel'
import { subscribeToMatch } from './services/matchRealtime'

type RoomPlayer = { id: string; name: string; deckName: string; ready: boolean }
type Room = { id: string; code?: string; name: string; format: string; privacy: string; status: string; players: RoomPlayer[]; spectators: number; createdAt: number }

type LobbyProps = {
  decks: SavedDeck[]
  onEditDeck: (deckId: string) => void
  onPractice: (deck: SavedDeck) => void
  onMatch: (roomId: string) => void
}

const RARITY_WEIGHT = { Common: 0, Uncommon: 1, Rare: 2, Mythic: 3 } as const

export function Lobby({ decks, onEditDeck, onPractice, onMatch }: LobbyProps) {
  const reduceMotion = useReducedMotion()
  const [lobby, setLobby] = useState<{ rooms: Room[]; online: number; queued: number }>({ rooms: [], online: 1, queued: 0 })
  const [selectedDeckId, setSelectedDeckId] = useState(decks[0]?.id)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [roomName, setRoomName] = useState('Casual spelltable')
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null)
  const [queueing, setQueueing] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(socket.connected)
  const [cloudUserId, setCloudUserId] = useState('')
  const [playerName] = useState(() => {
    const stored = localStorage.getItem('arcana.player-name')
    if (stored) return stored
    const generated = `Planeswalker ${Math.floor(100 + Math.random() * 900)}`
    localStorage.setItem('arcana.player-name', generated)
    return generated
  })
  const selectedDeck = decks.find((deck) => deck.id === selectedDeckId) || decks[0]
  const selectedDeckCards = useMemo(() => selectedDeck?.entries.flatMap((entry) => {
    const card = resolveDeckCard(entry)
    return card ? [card] : []
  }) ?? [], [selectedDeck])
  const deckPreviewCards = [...selectedDeckCards]
    .sort((left, right) => RARITY_WEIGHT[right.rarity] - RARITY_WEIGHT[left.rarity] || right.cost - left.cost || left.name.localeCompare(right.name))
    .slice(0, 3)
  const selectedDeckTotal = selectedDeck?.entries.reduce((sum, item) => sum + item.quantity, 0) ?? 0
  const selectedDeckColors = new Set(selectedDeckCards.map((card) => card.color).filter((color) => color !== 'colorless')).size

  useEffect(() => {
    if (isSupabaseConfigured) {
      let active = true
      let lobbySubscription: ReturnType<typeof subscribeToCloudLobby> | null = null
      const refresh = () => {
        void fetchCloudLobby().then((next) => {
          if (active) setLobby(next)
        }).catch((cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : 'Could not load the cloud lobby.')
        })
      }
      void getCloudUserId(playerName).then((userId) => {
        if (!active) return
        setCloudUserId(userId)
        lobbySubscription = subscribeToCloudLobby(userId, {
          onRefresh: refresh,
          onPresence: (online) => setLobby((current) => ({ ...current, online })),
          onStatus: (online) => setConnected(online),
        })
        refresh()
      }).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Supabase authentication failed.')
      })
      const refreshTimer = window.setInterval(refresh, 5_000)
      return () => {
        active = false
        window.clearInterval(refreshTimer)
        if (lobbySubscription) void lobbySubscription.unsubscribe()
      }
    }
    const onLobby = (data: typeof lobby) => setLobby(data)
    const onRoom = (room: Room) => setCurrentRoom(room)
    const start = ({ roomId }: { roomId: string }) => onMatch(roomId)
    const connectedNow = () => setConnected(true)
    const disconnected = () => setConnected(false)
    socket.on('lobby:update', onLobby)
    socket.on('room:update', onRoom)
    socket.on('match:start', start)
    socket.on('connect', connectedNow)
    socket.on('disconnect', disconnected)
    return () => {
      socket.off('lobby:update', onLobby)
      socket.off('room:update', onRoom)
      socket.off('match:start', start)
      socket.off('connect', connectedNow)
      socket.off('disconnect', disconnected)
    }
  }, [onMatch, playerName])

  useEffect(() => {
    if (!isSupabaseConfigured || !currentRoom || !cloudUserId) return
    const subscription = subscribeToMatch(currentRoom.id, {
      onSnapshot: (next) => {
        const room = snapshotToCloudRoom(next)
        if (next.status === 'active') {
          setQueueing(false)
          onMatch(room.id)
          return
        }
        setCurrentRoom(room)
      },
      onEvent: () => undefined,
      onStatus: (status) => setConnected(status === 'SUBSCRIBED'),
    })
    return () => { void subscription.unsubscribe() }
  }, [cloudUserId, currentRoom?.id, onMatch])

  const payload = useMemo(() => ({
    playerName,
    deckName: selectedDeck?.name || 'Starter Deck',
    deck: selectedDeck ? expandDeckCards(selectedDeck) : [],
    format: selectedDeck?.format || 'Standard',
  }), [playerName, selectedDeck])
  const visibleRooms = lobby.rooms.filter((room) => `${room.name} ${room.format} ${room.players[0]?.name}`.toLowerCase().includes(query.toLowerCase()))

  const createRoom = () => {
    if (isSupabaseConfigured) {
      void createCloudRoom({ ...payload, roomName, format: selectedDeck?.format || 'Standard', privacy: 'Public' })
        .then((room) => { setCurrentRoom(room); setCreating(false) })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not create room.'))
      return
    }
    socket.emit('room:create', { ...payload, roomName, format: selectedDeck?.format || 'Standard', privacy: 'Public' }, (response: { ok: boolean; room?: Room; error?: string }) => {
      if (response.ok && response.room) { setCurrentRoom(response.room); setCreating(false) }
      else setError(response.error || 'Could not create room.')
    })
  }

  const joinRoom = (roomId: string) => {
    if (isSupabaseConfigured) {
      void joinCloudRoom(roomId, payload)
        .then((room) => setCurrentRoom(room))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not join room.'))
      return
    }
    socket.emit('room:join', { ...payload, roomId }, (response: { ok: boolean; room?: Room; error?: string }) => {
      if (response.ok && response.room) setCurrentRoom(response.room)
      else setError(response.error || 'Could not join room.')
    })
  }

  const toggleQueue = () => {
    if (isSupabaseConfigured) {
      if (queueing && currentRoom) {
        void leaveCloudRoom(currentRoom.id).then(() => setCurrentRoom(null)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not leave queue.'))
        setQueueing(false)
        return
      }
      void findCloudQuickMatch({ ...payload, format: selectedDeck?.format || 'Standard' })
        .then((snapshot) => {
          const room = snapshotToCloudRoom(snapshot)
          if (snapshot.status === 'active') onMatch(room.id)
          else { setCurrentRoom(room); setQueueing(true) }
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not join quick match.'))
      return
    }
    if (queueing) socket.emit('queue:leave')
    else socket.emit('queue:join', payload)
    setQueueing((value) => !value)
  }

  const leaveRoom = () => {
    if (isSupabaseConfigured && currentRoom) {
      void leaveCloudRoom(currentRoom.id).catch(() => undefined)
    } else socket.emit('room:leave')
    setCurrentRoom(null)
    setQueueing(false)
  }

  return (
    <motion.div className="lobby-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="lobby-cinematic" aria-hidden="true">
        <motion.div className="lobby-cinematic-image" initial={reduceMotion ? false : { scale: 1.045, x: 18 }} animate={{ scale: 1, x: 0 }} transition={{ duration: reduceMotion ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }} />
        <div className="lobby-cinematic-shade" />
        <div className="lobby-cinematic-lines" />
      </div>
      <section className="lobby-main">
        <div className="lobby-heading">
          <div><span className="eyebrow"><Radio size={13} /> Live arena</span><h1>Enter the arena</h1><p>Choose your battleground and ready your deck.</p></div>
          <span className={`connection ${connected ? 'online' : ''}`}><CircleDot size={13} /> {connected ? `${lobby.online} online` : 'Reconnecting'}</span>
        </div>

        <div className="match-cards">
          <motion.button type="button" className={`match-option quick ${queueing ? 'searching' : ''}`} onClick={toggleQueue} initial={reduceMotion ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : .08, duration: .32 }} whileHover={reduceMotion ? undefined : { y: -4 }} whileTap={{ scale: .985 }}>
            <span className="mode-art" aria-hidden="true"><img src="/cards/lightning-bolt.jpg" alt="" /></span>
            <span className="mode-number">01</span>
            <span className="match-icon"><Zap /></span>
            <span className="mode-copy"><small>Ranked pairing</small><b>{queueing ? 'Finding opponent...' : 'Quick match'}</b><em>{queueing ? `${lobby.queued} player${lobby.queued === 1 ? '' : 's'} in queue` : 'Standard / Best of one'}</em></span>
            {queueing ? <i className="search-spinner" /> : <ChevronRight />}
          </motion.button>
          <motion.button type="button" className="match-option practice" onClick={() => selectedDeck && onPractice(selectedDeck)} initial={reduceMotion ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : .13, duration: .32 }} whileHover={reduceMotion ? undefined : { y: -4 }} whileTap={{ scale: .985 }}>
            <span className="mode-art" aria-hidden="true"><img src="/cards/questing-beast.jpg" alt="" /></span>
            <span className="mode-number">02</span>
            <span className="match-icon"><Bot /></span><span className="mode-copy"><small>Solo training</small><b>Practice table</b><em>Rule-enforced match against VEX_MAGE</em></span><ChevronRight />
          </motion.button>
        </div>

        <div className="rooms-head">
          <div><h2>Open tables</h2><span>{visibleRooms.length} available</span></div>
          <div><label><Search /><input aria-label="Search tables" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tables" /></label><button type="button" className="new-room" onClick={() => setCreating(true)}><Plus /> New table</button></div>
        </div>

        <div className="room-table">
          <div className="room-table-header"><span>Host / table</span><span>Format</span><span>Players</span><span>Ping</span><span /></div>
          <AnimatePresence>
            {visibleRooms.map((room) => (
              <motion.div className="room-row" key={room.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }}>
                <span className="room-identity"><i>{room.players[0]?.name.charAt(0)}</i><span><b>{room.name}</b><small>{room.players[0]?.name} · {room.id}</small></span></span>
                <span><b className="format-badge">{room.format}</b></span>
                <span className="room-players"><UsersRound /> {room.players.length}/2</span>
                <span className="ping"><i /> {22 + room.id.charCodeAt(0) % 35} ms</span>
                <button type="button" onClick={() => joinRoom(room.id)}>Join <ChevronRight /></button>
              </motion.div>
            ))}
          </AnimatePresence>
          {!visibleRooms.length && <div className="rooms-empty"><Globe2 /><b>No open tables yet</b><span>Create the first one or start quick match.</span></div>}
        </div>
      </section>

      <aside className="play-sidebar">
        <div className="selected-deck-head"><span>Play with</span></div>
        <div className="selected-deck-art">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div className="deck-fan" key={selectedDeck?.id} initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: .96 }} transition={{ duration: reduceMotion ? 0 : .3, ease: 'easeOut' }}>
              {deckPreviewCards.map((card, index) => <motion.img key={card.id} src={card.image} alt="" initial={reduceMotion ? false : { opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0, x: (index - 1) * 40, rotate: (index - 1) * 8, scale: index === 1 ? 1.08 : .96 }} transition={{ delay: reduceMotion ? 0 : index * .045, type: 'spring', stiffness: 300, damping: 25 }} />)}
            </motion.div>
          </AnimatePresence>
          <span className="deck-glow" />
        </div>
        <label className="deck-selector"><span>Selected deck</span><select aria-label="Selected deck" value={selectedDeckId} onChange={(event) => setSelectedDeckId(event.target.value)}>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label>
        <div className="deck-summary"><span><b>{selectedDeckTotal}</b><small>Cards</small></span><span><b>{selectedDeckColors}</b><small>Colors</small></span><span><b>{selectedDeck?.format}</b><small>Format</small></span></div>
        <button type="button" className="edit-deck-button" onClick={() => selectedDeck && onEditDeck(selectedDeck.id)}>Edit deck <ChevronRight /></button>
        <div className="loadout-status"><span><b>Deck selected</b><small>Ready for play</small></span></div>
      </aside>

      <AnimatePresence>
        {creating && (
          <motion.div className="dialog-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCreating(false)}>
            <motion.div className="create-room-dialog" initial={{ scale: .95, y: 18 }} animate={{ scale: 1, y: 0 }} exit={{ scale: .96 }} onClick={(event) => event.stopPropagation()}>
              <div className="dialog-title"><div><Gamepad2 /><span><b>Create table</b><small>Invite another player or list it publicly.</small></span></div><button type="button" onClick={() => setCreating(false)}><X /></button></div>
              <label>Table name<input value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
              <div className="create-options"><span><Globe2 /><b>Public</b><small>Visible in the lobby</small></span><span><Swords /><b>{selectedDeck?.format}</b><small>Game format</small></span></div>
              <button type="button" className="create-submit" onClick={createRoom}>Create table <ChevronRight /></button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {currentRoom && (
          <motion.div className="room-waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="waiting-top"><button type="button" onClick={leaveRoom}><X /></button><span>TABLE {currentRoom.id}</span><button type="button" title="Copy invite code" onClick={() => navigator.clipboard?.writeText(currentRoom.id)}><Copy /></button></div>
            <div className="versus-seats">
              {[0, 1].map((seat) => {
                const player = currentRoom.players[seat]
                return <div key={seat} className={`seat ${player ? 'filled' : ''} ${player?.ready ? 'ready' : ''}`}>{player ? <><i>{player.name.charAt(0)}</i><b>{player.name}</b><small>{player.deckName}</small>{player.ready && <span><Check /> Ready</span>}</> : <><i><UserRound /></i><b>Waiting for player</b><small>Share code {currentRoom.id}</small></>}</div>
              })}
              <span className="versus">VS</span>
            </div>
            <button type="button" className="ready-button" onClick={() => {
              if (isSupabaseConfigured) {
                const mine = currentRoom.players.find((player) => player.id === cloudUserId)
                void setCloudRoomReady(currentRoom.id, !mine?.ready).then((next) => {
                  const room = snapshotToCloudRoom(next)
                  if (next.status === 'active') onMatch(room.id)
                  else setCurrentRoom(room)
                }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not update readiness.'))
              } else socket.emit('room:ready')
            }}><Check /> {currentRoom.players.find((player) => player.id === (isSupabaseConfigured ? cloudUserId : socket.id))?.ready ? 'Cancel ready' : 'Ready to play'}</button>
            <p><Clock3 /> Match starts when both players are ready</p>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <button type="button" className="lobby-error" onClick={() => setError('')}><Lock /> {error}<X /></button>}
    </motion.div>
  )
}
