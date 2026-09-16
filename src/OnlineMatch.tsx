import { AnimatePresence, motion } from 'framer-motion'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { ArrowLeft, ChevronRight, Clock3, Eye, Flag, Heart, MessageCircle, Minus, Plus, Send, Settings2, Swords, Volume2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CardPeek, CardZoom } from './CardZoom'
import { catalog, type CatalogCard } from './catalog'
import { socket } from './socket'
import {
  applyCloudMatchAction,
  fetchCloudMatch,
  getCloudUserId,
  leaveCloudRoom,
  type CloudMatchAction,
} from './services/cloudMatch'
import { snapshotToMatchState, type MatchState, type RemoteCard } from './services/cloudMatchModel'
import { broadcastMatchChat, subscribeToMatch } from './services/matchRealtime'
import { isSupabaseConfigured } from './services/supabase'

type ChatMessage = { id: number; player: string; text: string }

function displayCard(card: RemoteCard): CatalogCard {
  return catalog.find((item) => item.id === card.id) || { id: card.id, name: card.name, image: card.image, color: card.color ?? 'colorless', kind: card.kind as CatalogCard['kind'], cost: card.cost, mana: card.mana ?? `${card.cost}`, typeLine: card.typeLine ?? card.kind, rules: card.rules ?? '', rarity: card.rarity ?? 'Common', power: card.power ?? undefined, toughness: card.toughness ?? undefined }
}

function OnlineCard({ card, small = false, disabled = false, onClick, onZoom, onHover }: { card: RemoteCard; small?: boolean; disabled?: boolean; onClick?: () => void; onZoom: () => void; onHover?: () => void }) {
  return <motion.button type="button" disabled={disabled} className={`online-card ${small ? 'small' : ''} ${card.tapped ? 'is-tapped' : ''}`} onClick={onClick} onMouseEnter={onHover} onFocus={onHover} onContextMenu={(event) => { event.preventDefault(); onZoom() }} onDoubleClick={onZoom} whileHover={disabled ? undefined : { y: small ? -10 : -5, scale: 1.06, zIndex: 10 }} whileTap={disabled ? undefined : { scale: .96 }}><img src={card.image} alt={card.name} /><span className="online-cost">{card.cost}</span>{card.power != null && <b className="online-stats">{card.power}/{card.toughness}</b>}</motion.button>
}

export function OnlineMatch({ roomId, onExit }: { roomId: string; onExit: () => void }) {
  const [state, setState] = useState<MatchState | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [selectedCard, setSelectedCard] = useState<CatalogCard | null>(null)
  const [zoomedCard, setZoomedCard] = useState<CatalogCard | null>(null)
  const [showChat, setShowChat] = useState(true)
  const [showActions, setShowActions] = useState(false)
  const [cloudUserId, setCloudUserId] = useState('')
  const [cloudChannel, setCloudChannel] = useState<RealtimeChannel | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [actionPending, setActionPending] = useState(false)

  useEffect(() => {
    if (isSupabaseConfigured) {
      let active = true
      let subscription: ReturnType<typeof subscribeToMatch> | null = null
      void getCloudUserId().then(async (userId) => {
        if (!active) return
        setCloudUserId(userId)
        const initial = await fetchCloudMatch(roomId)
        if (!active) return
        const initialState = snapshotToMatchState(initial)
        if (initialState) setState(initialState)
        subscription = subscribeToMatch(roomId, {
          onSnapshot: (next) => {
            const nextState = snapshotToMatchState(next)
            if (nextState) setState(nextState)
          },
          onEvent: () => undefined,
          onChat: (message) => setChat((items) => [...items.slice(-20), {
            id: message.id,
            player: message.actorId === userId ? 'You' : 'Opponent',
            text: message.text,
          }]),
          onStatus: (status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnectionError('Realtime connection interrupted.')
          },
        })
        setCloudChannel(subscription.channel)
      }).catch((cause: unknown) => {
        if (active) setConnectionError(cause instanceof Error ? cause.message : 'Could not connect to this match.')
      })
      return () => {
        active = false
        setCloudChannel(null)
        if (subscription) void subscription.unsubscribe()
      }
    }
    const update = (next: MatchState) => setState(next)
    const incoming = (message: ChatMessage) => setChat((items) => [...items.slice(-20), message])
    socket.on('match:state', update)
    socket.on('match:chat', incoming)
    socket.emit('match:get', roomId)
    return () => { socket.off('match:state', update); socket.off('match:chat', incoming) }
  }, [roomId])

  const localPlayerId = isSupabaseConfigured ? cloudUserId : socket.id
  const me = state?.players.find((player) => player.id === localPlayerId)
  const opponent = state?.players.find((player) => player.id !== localPlayerId)
  const isMyTurn = !!state && state.activePlayer === me?.index
  const hasPriority = !!state && state.priorityPlayer === me?.index
  const topStackItem = state?.stack.at(-1)
  const act = (action: CloudMatchAction) => {
    if (actionPending) return
    if (isSupabaseConfigured) {
      setActionPending(true)
      setConnectionError('')
      void applyCloudMatchAction(roomId, action).then((next) => {
        const nextState = snapshotToMatchState(next)
        if (nextState) setState(nextState)
      }).catch((cause: unknown) => setConnectionError(cause instanceof Error ? cause.message : 'The action was rejected.'))
        .finally(() => setActionPending(false))
      return
    }
    socket.emit('match:action', { roomId, type: action.type, payload: action.payload || {} })
  }
  const sendChat = () => {
    const text = chatText.trim()
    if (!text) return
    if (isSupabaseConfigured) {
      if (!cloudChannel || !cloudUserId) {
        setConnectionError('Realtime chat is still connecting.')
        return
      }
      void broadcastMatchChat(cloudChannel, { id: Date.now(), actorId: cloudUserId, text })
        .then(() => setChatText(''))
        .catch((cause: unknown) => setConnectionError(cause instanceof Error ? cause.message : 'Could not send message.'))
      return
    }
    socket.emit('match:chat', { roomId, text })
    setChatText('')
  }

  const exitMatch = () => {
    if (isSupabaseConfigured) void leaveCloudRoom(roomId).catch(() => undefined)
    onExit()
  }

  if (!state || !me || !opponent) return <div className="online-loading"><span className="loading-glyph"><Zap /></span><b>{connectionError ? 'Connection failed' : 'Syncing table'}</b><small>{connectionError || 'Connecting to the other planeswalker...'}</small><button type="button" onClick={exitMatch}>Return to lobby</button></div>

  return (
    <motion.div className="online-match" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <header className="online-topbar"><button type="button" className="back-match" onClick={exitMatch}><ArrowLeft /> Lobby</button><div className="online-room-title"><span>LIVE TABLE</span><b>{roomId}</b><i><span /> {actionPending ? 'Syncing' : 'Connected'}</i></div><div className="online-top-actions"><span><Clock3 /> Live</span><span>TURN {state.turn}</span><button type="button" aria-label="Match settings" aria-expanded={showActions} onClick={() => setShowActions((value) => !value)}><Settings2 /></button></div></header>
      <div className="online-game-grid">
        <section className="remote-board">
          <div className="remote-player opponent-player"><div className="remote-avatar">{opponent.name.charAt(0)}</div><span><b>{opponent.name}</b><small>{opponent.index === 0 ? 'Challenger' : 'Opponent'} · {opponent.battlefield.length} permanents</small></span><strong><Heart /> {opponent.life}</strong></div>
          <div className="remote-zone opponent-hand"><div className="remote-zone-label">HIDDEN HAND <span>{opponent.hand.length}</span></div><div className="card-row facedown-row">{opponent.hand.map((card, index) => <span key={card.uid} className="facedown" style={{ transform: `translateX(${(index - opponent.hand.length / 2) * 11}px) rotate(${(index - opponent.hand.length / 2) * 2}deg)` }} />)}</div></div>
          <div className="remote-zone opponent-field"><div className="remote-zone-label">BATTLEFIELD</div><div className="card-row">{opponent.battlefield.map((card) => <OnlineCard key={card.uid} card={card} onHover={() => setSelectedCard(displayCard(card))} onZoom={() => setZoomedCard(displayCard(card))} />)}</div></div>
          <div className="remote-center-line"><span /><div><Swords /> <b>{state.phase.replaceAll('_', ' ')}{state.stack.length ? ` · stack ${state.stack.length}` : ''}</b></div><span /></div>
          <AnimatePresence>{topStackItem && <motion.aside key={topStackItem.id} className="remote-stack" aria-label={`${topStackItem.card.name} is on top of the stack`} initial={{ opacity: 0, scale: .75, y: 28 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 1.15 }}><span>STACK · {state.stack.length}</span><OnlineCard card={topStackItem.card} onHover={() => setSelectedCard(displayCard(topStackItem.card))} onZoom={() => setZoomedCard(displayCard(topStackItem.card))} /></motion.aside>}</AnimatePresence>
          <div className="remote-zone my-field"><div className="remote-zone-label">YOUR BATTLEFIELD</div><div className="card-row">{me.battlefield.map((card) => <OnlineCard key={card.uid} card={card} disabled={actionPending} onClick={() => act({ type: 'tap', payload: { uid: card.uid } })} onHover={() => setSelectedCard(displayCard(card))} onZoom={() => setZoomedCard(displayCard(card))} />)}</div></div>
          <div className="remote-player my-player"><div className="remote-avatar self-avatar">{me.name.charAt(0)}</div><span><b>{me.name}</b><small>{hasPriority ? 'Your priority' : isMyTurn ? 'Your turn' : 'Waiting for opponent'}</small></span><strong><Heart /> {me.life}</strong></div>
          <div className="remote-zone my-hand"><div className="remote-zone-label">YOUR HAND <span>{me.hand.length}</span></div><div className="card-row my-hand-row">{me.hand.map((card) => <OnlineCard key={card.uid} card={card} small disabled={!hasPriority || actionPending} onClick={() => act({ type: 'play', payload: { uid: card.uid } })} onHover={() => setSelectedCard(displayCard(card))} onZoom={() => setZoomedCard(displayCard(card))} />)}</div></div>
        </section>
        <aside className={`match-utility ${showChat ? '' : 'collapsed'}`}>
          <div className="utility-tabs"><button type="button" className={showChat ? 'active' : ''} onClick={() => setShowChat(true)}><MessageCircle /> Chat</button><button type="button" className={!showChat ? 'active' : ''} onClick={() => setShowChat(false)}><Eye /> Log</button></div>
          {showChat ? <><div className="live-chat">{chat.length ? chat.map((message) => <div key={message.id}><i>{message.player.charAt(0)}</i><span><b>{message.player}</b><small>{message.text}</small></span></div>) : <div className="chat-empty"><MessageCircle /><span>No messages yet.<br />Say hello to your opponent.</span></div>}</div><div className="chat-input"><input aria-label="Chat message" value={chatText} onChange={(event) => setChatText(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && sendChat()} placeholder="Message table" /><button type="button" aria-label="Send chat message" onClick={sendChat}><Send /></button></div></> : <div className="live-log">{state.log.slice(-10).reverse().map((item) => <div key={item.id}><span />{item.text}</div>)}</div>}
        </aside>
      </div>
      <footer className="online-actionbar"><div className="action-status"><span className={hasPriority ? 'turn-dot' : ''} />{actionPending ? 'Confirming action' : hasPriority ? 'Your priority' : isMyTurn ? 'Your turn' : `${opponent.name}'s turn`}<small>Click cards to play · right-click or double-click to zoom</small></div><div className="life-controls"><button type="button" aria-label="Lose one life" disabled={actionPending} onClick={() => act({ type: 'life', payload: { delta: -1 } })}><Minus /></button><span>Adjust life</span><button type="button" aria-label="Gain one life" disabled={actionPending} onClick={() => act({ type: 'life', payload: { delta: 1 } })}><Plus /></button></div><button type="button" className="end-turn" disabled={!hasPriority || actionPending} onClick={() => act({ type: 'pass' })}><span>{actionPending ? 'Syncing' : hasPriority ? state.stack.length ? 'Pass response' : 'Pass priority' : 'Waiting'}</span><ChevronRight /></button><button type="button" className="flag-match" aria-label="Leave match" onClick={exitMatch}><Flag /></button></footer>
      {connectionError && <button type="button" className="lobby-error" onClick={() => setConnectionError('')}>{connectionError}</button>}
      <AnimatePresence>{showActions && <motion.div className="online-actions-pop" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}><button type="button"><Volume2 /> Sound on</button><button type="button" onClick={exitMatch}><Flag /> Leave match</button></motion.div>}</AnimatePresence>
      <CardPeek card={selectedCard} onOpen={() => setZoomedCard(selectedCard)} />
      <CardZoom card={zoomedCard} onClose={() => setZoomedCard(null)} />
    </motion.div>
  )
}
