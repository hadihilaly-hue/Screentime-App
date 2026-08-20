import Anthropic from 'npm:@anthropic-ai/sdk@^0.120.0'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@^2.112.3'

/**
 * The Anthropic key lives here and only here. It is a Supabase secret, never a
 * VITE_ variable, so it never reaches the browser bundle.
 */
export const anthropic = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
})

export const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6'

/** Service-role client: bypasses RLS. Only ever used after the caller's JWT
 *  has been checked and the row's user_id has been matched to them. */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

/** Resolves the calling user from the request's Authorization header. */
export async function requireUser(req: Request): Promise<{ id: string }> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new Response('Missing Authorization header', { status: 401 })

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  )
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Response('Invalid session', { status: 401 })
  return { id: data.user.id }
}

/**
 * Claude returns JSON-schema-constrained output, so the text block parses
 * cleanly. Fences are stripped anyway as a belt-and-braces measure.
 */
export function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(cleaned) as T
}

export function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}
