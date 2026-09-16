import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  }
  return supabase
}

export async function ensureAnonymousSession(displayName = 'Planeswalker') {
  const client = requireSupabase()
  const { data: sessionData } = await client.auth.getSession()
  if (sessionData.session) return sessionData.session

  const { data, error } = await client.auth.signInAnonymously({
    options: { data: { display_name: displayName.slice(0, 32) } },
  })
  if (error) throw error
  if (!data.session) throw new Error('Supabase did not create an anonymous session.')
  return data.session
}
