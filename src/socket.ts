import { io } from 'socket.io-client'

const serverUrl = import.meta.env.DEV ? 'http://localhost:4174' : window.location.origin
const cloudRealtimeConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL?.trim() && import.meta.env.VITE_SUPABASE_ANON_KEY?.trim(),
)

export const socket = io(serverUrl, {
  autoConnect: !cloudRealtimeConfigured,
  transports: ['websocket', 'polling'],
})
