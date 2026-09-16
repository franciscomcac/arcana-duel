import express from 'express'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Server } from 'socket.io'
import { applyRemoteMatchAction } from './matchRules.js'

const app = express()
const server = createServer(app)
const io = new Server(server, { cors: { origin: true, credentials: true } })
const port = Number(process.env.PORT || 4174)
const rooms = new Map()
const queued = []

const catalog = {
  forest: { id: 'forest', name: 'Forest', image: '/cards/forest.jpg', kind: 'land', cost: 0, power: null, toughness: null },
  mountain: { id: 'mountain', name: 'Mountain', image: '/cards/mountain.jpg', kind: 'land', cost: 0, power: null, toughness: null },
  'llanowar-elves': { id: 'llanowar-elves', name: 'Llanowar Elves', image: '/cards/llanowar-elves.jpg', kind: 'creature', cost: 1, power: 1, toughness: 1 },
  'elvish-mystic': { id: 'elvish-mystic', name: 'Elvish Mystic', image: '/cards/elvish-mystic.jpg', kind: 'creature', cost: 1, power: 1, toughness: 1 },
  'grizzly-bears': { id: 'grizzly-bears', name: 'Grizzly Bears', image: '/cards/grizzly-bears.jpg', kind: 'creature', cost: 2, power: 2, toughness: 2 },
  'kird-ape': { id: 'kird-ape', name: 'Kird Ape', image: '/cards/kird-ape.jpg', kind: 'creature', cost: 1, power: 2, toughness: 3 },
  'kessig-naturalist': { id: 'kessig-naturalist', name: 'Kessig Naturalist', image: '/cards/kessig-naturalist.jpg', kind: 'creature', cost: 2, power: 2, toughness: 2 },
  'reclamation-sage': { id: 'reclamation-sage', name: 'Reclamation Sage', image: '/cards/reclamation-sage.jpg', kind: 'creature', cost: 3, power: 2, toughness: 1 },
  'questing-beast': { id: 'questing-beast', name: 'Questing Beast', image: '/cards/questing-beast.jpg', kind: 'creature', cost: 4, power: 4, toughness: 4 },
  'lightning-bolt': { id: 'lightning-bolt', name: 'Lightning Bolt', image: '/cards/lightning-bolt.jpg', kind: 'instant', cost: 1, power: null, toughness: null },
  shock: { id: 'shock', name: 'Shock', image: '/cards/shock.jpg', kind: 'instant', cost: 1, power: null, toughness: null },
  'giant-growth': { id: 'giant-growth', name: 'Giant Growth', image: '/cards/giant-growth.jpg', kind: 'instant', cost: 1, power: null, toughness: null },
  embercleave: { id: 'embercleave', name: 'Embercleave', image: '/cards/embercleave.jpg', kind: 'artifact', cost: 6, power: null, toughness: null },
}

const fallbackDeck = [
  ...Array(12).fill('forest'), ...Array(12).fill('mountain'),
  ...Array(4).fill('llanowar-elves'), ...Array(4).fill('elvish-mystic'),
  ...Array(4).fill('grizzly-bears'), ...Array(4).fill('kird-ape'),
  ...Array(4).fill('kessig-naturalist'), ...Array(4).fill('reclamation-sage'),
  ...Array(4).fill('lightning-bolt'), ...Array(4).fill('giant-growth'),
]

function publicRooms() {
  return [...rooms.values()].filter((room) => room.status === 'waiting').map(({ state: _state, ...room }) => room)
}

function broadcastLobby() {
  io.emit('lobby:update', { rooms: publicRooms(), online: io.engine.clientsCount, queued: queued.length })
}

function hydrateDeck(deck) {
  const ids = Array.isArray(deck) && deck.length ? deck : fallbackDeck
  const hydrated = []
  ids.forEach((item) => {
    // Never trust a client-supplied card object's stats directly: always resolve against the
    // server's catalog by id, and silently drop anything that doesn't resolve to a known card.
    const catalogId = typeof item === 'string' ? item : (item && typeof item === 'object' ? item.id : undefined)
    const source = typeof catalogId === 'string' ? catalog[catalogId] : undefined
    if (!source) return
    hydrated.push({ ...source, uid: `${source.id}-${hydrated.length}-${Math.random().toString(36).slice(2, 7)}`, tapped: false })
  })
  return hydrated.length ? hydrated : hydrateDeck(fallbackDeck)
}

function makeState(room) {
  const players = room.players.map((player, index) => {
    const cards = hydrateDeck(player.deck)
    return { id: player.id, name: player.name, life: 20, hand: cards.slice(0, 7), library: cards.slice(7), battlefield: [], graveyard: [], index, landsPlayedThisTurn: 0 }
  })
  return { turn: 1, activePlayer: 0, priorityPlayer: 0, consecutivePasses: 0, phase: 'main1', stack: [], players, log: [{ id: Date.now(), text: `${players[0].name} takes the first turn.` }] }
}


function createRoom(socket, payload = {}) {
  const id = Math.random().toString(36).slice(2, 7).toUpperCase()
  const room = {
    id,
    name: payload.roomName || `${payload.playerName || 'Player'}'s table`,
    format: payload.format || 'Standard',
    privacy: payload.privacy || 'Public',
    status: 'waiting',
    players: [{ id: socket.id, name: payload.playerName || 'Planeswalker', deckName: payload.deckName || 'Starter Deck', deck: payload.deck || fallbackDeck, ready: false }],
    spectators: 0,
    createdAt: Date.now(),
    state: null,
  }
  rooms.set(id, room)
  socket.join(id)
  socket.data.roomId = id
  return room
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId
  if (!roomId) return
  const room = rooms.get(roomId)
  if (room) {
    room.players = room.players.filter((player) => player.id !== socket.id)
    // Prune the room once nobody is left connected to it, whether it finished, was abandoned
    // mid-match, or never got a second player.
    if (!room.players.length) rooms.delete(roomId)
    else io.to(roomId).emit('room:update', room)
  }
  socket.leave(roomId)
  socket.data.roomId = null
}

function beginMatch(room) {
  room.status = 'playing'
  room.state = makeState(room)
  io.to(room.id).emit('match:start', { roomId: room.id })
  io.to(room.id).emit('match:state', room.state)
  broadcastLobby()
}

io.on('connection', (socket) => {
  broadcastLobby()
  socket.emit('lobby:update', { rooms: publicRooms(), online: io.engine.clientsCount, queued: queued.length })

  socket.on('room:create', (payload, reply) => {
    leaveCurrentRoom(socket)
    const room = createRoom(socket, payload)
    reply?.({ ok: true, room })
    io.to(room.id).emit('room:update', room)
    broadcastLobby()
  })

  socket.on('room:join', (payload, reply) => {
    try {
      const safePayload = payload && typeof payload === 'object' ? payload : {}
      const room = typeof safePayload.roomId === 'string' ? rooms.get(safePayload.roomId) : undefined
      if (!room || room.status !== 'waiting' || room.players.length >= 2) return reply?.({ ok: false, error: 'This room is no longer available.' })
      leaveCurrentRoom(socket)
      room.players.push({ id: socket.id, name: safePayload.playerName || 'Planeswalker', deckName: safePayload.deckName || 'Starter Deck', deck: safePayload.deck || fallbackDeck, ready: false })
      socket.join(room.id)
      socket.data.roomId = room.id
      reply?.({ ok: true, room })
      io.to(room.id).emit('room:update', room)
      broadcastLobby()
    } catch (error) {
      console.error('room:join failed', error)
      reply?.({ ok: false, error: 'Could not join that room.' })
      socket.emit('error:message', { scope: 'room:join', error: 'Could not join that room.' })
    }
  })

  socket.on('room:ready', () => {
    const room = rooms.get(socket.data.roomId)
    if (!room) return
    const player = room.players.find((item) => item.id === socket.id)
    if (player) player.ready = !player.ready
    io.to(room.id).emit('room:update', room)
    if (room.players.length === 2 && room.players.every((item) => item.ready)) beginMatch(room)
  })

  socket.on('room:leave', () => { leaveCurrentRoom(socket); broadcastLobby() })

  socket.on('queue:join', (payload) => {
    if (queued.some((item) => item.socketId === socket.id)) return
    const waiting = queued.shift()
    if (waiting) {
      const first = io.sockets.sockets.get(waiting.socketId)
      if (!first) { queued.push({ socketId: socket.id, payload }); return broadcastLobby() }
      const room = createRoom(first, { ...waiting.payload, roomName: 'Quick Match', privacy: 'Matchmade' })
      room.players[0].ready = true
      room.players.push({ id: socket.id, name: payload.playerName, deckName: payload.deckName, deck: payload.deck, ready: true })
      socket.join(room.id)
      socket.data.roomId = room.id
      beginMatch(room)
    } else queued.push({ socketId: socket.id, payload })
    broadcastLobby()
  })

  socket.on('queue:leave', () => {
    const index = queued.findIndex((item) => item.socketId === socket.id)
    if (index >= 0) queued.splice(index, 1)
    broadcastLobby()
  })

  socket.on('match:get', (roomId) => {
    const room = rooms.get(roomId)
    if (room?.state) socket.emit('match:state', room.state)
  })

  socket.on('match:action', (message) => {
    try {
      const safeMessage = message && typeof message === 'object' ? message : {}
      const { roomId, type, payload } = safeMessage
      if (typeof roomId !== 'string' || typeof type !== 'string') return
      const room = rooms.get(roomId)
      const state = room?.state
      if (!state) return
      const playerIndex = state.players.findIndex((player) => player.id === socket.id)
      if (playerIndex < 0) return
      const result = applyRemoteMatchAction(state, playerIndex, type, payload)
      if (!result.accepted) return
      room.state = result.state
      if (result.state.winner !== undefined || result.state.draw) room.status = 'complete'
      io.to(roomId).emit('match:state', result.state)
    } catch (error) {
      console.error('match:action failed', error)
      socket.emit('error:message', { scope: 'match:action', error: 'That action could not be applied.' })
    }
  })

  socket.on('match:chat', (message) => {
    try {
      const safeMessage = message && typeof message === 'object' ? message : {}
      const { roomId, text } = safeMessage
      if (typeof roomId !== 'string') return
      const room = rooms.get(roomId)
      const player = room?.players.find((item) => item.id === socket.id)
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (room && player && trimmed) io.to(roomId).emit('match:chat', { id: Date.now(), player: player.name, text: trimmed.slice(0, 240) })
    } catch (error) {
      console.error('match:chat failed', error)
      socket.emit('error:message', { scope: 'match:chat', error: 'That message could not be sent.' })
    }
  })

  socket.on('disconnect', () => {
    const queueIndex = queued.findIndex((item) => item.socketId === socket.id)
    if (queueIndex >= 0) queued.splice(queueIndex, 1)
    leaveCurrentRoom(socket)
    broadcastLobby()
  })
})

const root = dirname(dirname(fileURLToPath(import.meta.url)))
app.use(express.static(join(root, 'dist')))
// Express 5 no longer accepts the bare `*` path. Use a final middleware
// fallback so client-side routes still resolve to the Vite entrypoint.
app.use((_request, response) => response.sendFile(join(root, 'dist', 'index.html')))

server.listen(port, '0.0.0.0', () => console.log(`Arcana server listening on http://localhost:${port}`))
