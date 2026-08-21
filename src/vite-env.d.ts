/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Undefined until .env exists, which is exactly what isSupabaseConfigured checks.
  readonly VITE_SUPABASE_URL: string | undefined
  readonly VITE_SUPABASE_ANON_KEY: string | undefined
  // The Chrome extension's id, from chrome://extensions. Optional: without it
  // the app simply never sends the re-check hint and the extension falls back
  // to its own poll (src/lib/extension.ts).
  readonly VITE_EXTENSION_ID: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
