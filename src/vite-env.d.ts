/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Undefined until .env exists, which is exactly what isSupabaseConfigured checks.
  readonly VITE_SUPABASE_URL: string | undefined
  readonly VITE_SUPABASE_ANON_KEY: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
