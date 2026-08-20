import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isConfigured = Boolean(url && anonKey)

/**
 * The anon key is safe in the bundle — Row Level Security is what actually
 * protects the data. The Anthropic key is not here and never will be; it lives
 * as a Supabase secret behind the Edge Functions.
 */
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'anon', {
  auth: { persistSession: true, autoRefreshToken: true },
})
