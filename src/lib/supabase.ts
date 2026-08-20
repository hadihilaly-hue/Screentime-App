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

/** Use inside data helpers so the null case fails with a readable message. */
export function requireClient(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase is not configured. Copy .env.example to .env and fill it in.')
  }
  return supabase
}
