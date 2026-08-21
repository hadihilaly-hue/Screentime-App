import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** False until .env holds real values. */
export const isSupabaseConfigured = Boolean(url && anonKey)

// Vite inlines env vars at build time, so a production build with these unset
// would otherwise ship an app with nothing behind the auth gate. Fail loudly
// instead: a broken deploy is far better than a wide-open one.
if (!isSupabaseConfigured && import.meta.env.PROD) {
  throw new Error(
    'EarnedTime: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set at build time. ' +
      'Set them in your hosting provider’s environment variables and rebuild.',
  )
}

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null

/**
 * The same two values again, for the one caller that needs the raw URL and key
 * rather than the client: src/lib/proof.ts calls the verify-proof Edge Function
 * with fetch instead of functions.invoke(), because invoke() hides the response
 * body of a non-2xx reply behind an error object, and that body is precisely
 * what proof submission has to read — "storage could not be reached" and "you
 * have used today's three attempts" are different screens.
 */
export const supabaseUrl = url as string
export const supabaseAnonKey = anonKey as string

/** Use inside data helpers so the null case fails with a readable message. */
export function requireClient(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase is not configured. Copy .env.example to .env and fill it in.')
  }
  return supabase
}
