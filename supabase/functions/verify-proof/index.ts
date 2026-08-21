/**
 * verify-proof — decides whether a task's photos show the task was done.
 *
 * Deployed to Supabase Edge Functions (Deno). Step-by-step deploy instructions,
 * written for someone who has never used the Supabase CLI, are in
 * supabase/PROOF-SETUP.md.
 *
 * Why this runs on a server at all: the Anthropic API key. Spec section 1 —
 * "never put your Anthropic API key in frontend code". Everything else here
 * could have lived in the browser; the key could not.
 *
 * WHAT THIS FUNCTION DOES NOT DO: it never grants minutes, and it never sets
 * tasks.status. It writes a verdict and stops. The app reads that verdict and,
 * only if it says verified, calls the same completeTask() it has always called
 * — which claims the task with a compare-and-swap and credits the balance with
 * another one. The credit path is untouched by this feature, deliberately: it
 * is the part of the app that has been rewritten the most times, and it is
 * correct now.
 *
 * The column grants in migration-05 are what make that split real. This
 * function writes the verdict with the service_role key; the browser is not
 * granted UPDATE on those columns and cannot forge one.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@^0.120.0'

const MODEL = 'claude-sonnet-4-6'

/** Spec section 4.4: 1 to 3 photos. */
const MAX_PHOTOS = 3

/**
 * Attempts per task per UTC day, counted in public.verification_attempts.
 *
 * A cost guard, not a rule of the game. A follow-up answer costs one too,
 * because it is a second API call — the app shows the remaining count so that
 * is never a surprise.
 */
const MAX_ATTEMPTS_PER_DAY = 3

/**
 * The verifier's disposition.
 *
 * This deliberately departs from spec section 6b, which says "be fair but
 * skeptical". The build request for this feature overrides it: lenient, verify
 * unless the photos clearly do not match, prefer a follow-up question to a
 * rejection. The reasoning is that this is a tool someone chose to point at
 * themselves — a verifier that argues with you about whether your homework
 * looks substantive enough is a verifier you stop using in a week, and an
 * uninstalled honesty aid measures nothing. Spec section 7 already says
 * Phase 1's real enforcement is visibility, not interception.
 *
 * If it turns out to wave everything through, this string is the dial.
 */
const SYSTEM_PROMPT = `You check whether photos show that a task was done.

The person photographing the work is doing it for themselves. This is an
honesty aid they chose to use, not an exam, and you are not a proctor. Lean
towards believing them.

You are given a task title, its tier, sometimes a hint about what proof would
look like, and one to three photos.

Choose one verdict:

- "verified" — the photos could reasonably be of this task. This is the
  default. You are not grading the work: partial, messy, short, or hard to read
  all still count as done. Handwriting you cannot fully make out is fine.
  Choose this whenever the photos are plausibly related to the task.

- "needs_followup" — you genuinely cannot tell what you are looking at, or the
  photos could just as easily be of something else. Ask ONE short, specific
  question the person can answer from memory if they did the work. Prefer this
  to rejecting.

- "rejected" — only when the photos clearly are not of this task: a completely
  different subject, a blank page, a photo of a wall, a ceiling, a floor, a
  pet, or an image with no work in it at all. Never reject because the work
  looks thin, rushed, or incomplete.

When you are unsure, prefer "verified" over "needs_followup", and
"needs_followup" over "rejected".

Give the reason as one short sentence addressed to the person, in plain
language. For a rejection, say what a passing photo would show.`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Verdict = 'verified' | 'rejected' | 'needs_followup'

interface TaskRow {
  id: string
  user_id: string
  title: string
  tier: number
  status: string
  proof_hint: string | null
  verification_verdict: Verdict | null
  followup_question: string | null
}

/**
 * Every failure this function can produce has a code, and the app renders each
 * one as its own state. Nothing here ever falls back to "verified" or to
 * "rejected" — a task whose verification did not happen is a task in neither
 * state, which is the whole point of the failure-honesty requirement. A storage
 * outage must not read as cheating, and an API outage must not read as a pass.
 */
function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, error: code, message, ...extra }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function ok(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/**
 * Bytes to base64, in chunks.
 *
 * `btoa(String.fromCharCode(...bytes))` is the obvious one-liner and it throws
 * on a photo: spreading a million-element array overflows the argument stack.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

interface ProofImage {
  media_type: ImageMediaType
  data: string
}

function mediaTypeFor(name: string, blobType: string): ImageMediaType {
  const t = (blobType || '').toLowerCase()
  if (t === 'image/png' || t === 'image/webp' || t === 'image/jpeg') return t
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

/** The one tool the model is forced to call, so the verdict arrives structured. */
function verdictTool(allowed: Verdict[]) {
  return {
    name: 'record_verdict',
    description: 'Record the verification decision for this task. Call this exactly once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        verdict: {
          type: 'string',
          enum: allowed,
          description: 'The decision.',
        },
        reason: {
          type: 'string',
          description:
            'One short sentence addressed to the person, explaining the decision in plain language.',
        },
        followup_question: {
          type: 'string',
          description:
            'Only when verdict is needs_followup: one short question answerable from memory by someone who did the work. Omit otherwise.',
        },
      },
      required: ['verdict', 'reason'],
    },
  }
}

interface VerdictResult {
  verdict: Verdict
  reason: string
  followup_question: string | null
}

/**
 * Pull the forced tool call out of the response.
 *
 * Returns null rather than guessing when the model answered in some other
 * shape. The caller turns that into its own error state — a verdict that could
 * not be read is not a verdict, and inventing one in either direction is
 * exactly the silent pass or silent fail this feature is not allowed to have.
 */
function readVerdict(message: Anthropic.Message, allowed: Verdict[]): VerdictResult | null {
  for (const block of message.content) {
    if (block.type !== 'tool_use' || block.name !== 'record_verdict') continue
    const input = block.input as Record<string, unknown>
    const verdict = input?.verdict
    const reason = input?.reason
    if (typeof verdict !== 'string' || !allowed.includes(verdict as Verdict)) return null
    const question = typeof input?.followup_question === 'string' ? input.followup_question : null
    return {
      verdict: verdict as Verdict,
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : '',
      // A needs_followup with no question is unusable, so it is not a valid
      // verdict — the caller reports it rather than showing an empty prompt.
      followup_question: verdict === 'needs_followup' ? question : null,
    }
  }
  return null
}

async function loadPhotos(
  admin: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<{ images: ProofImage[] } | { storageError: string }> {
  const prefix = `${userId}/${taskId}`
  const { data: listing, error: listError } = await admin.storage
    .from('proofs')
    .list(prefix, { limit: 20, sortBy: { column: 'name', order: 'asc' } })
  if (listError) return { storageError: listError.message }

  const files = (listing ?? [])
    // Supabase returns a placeholder row for empty folders; real objects have an id.
    .filter((f) => f.id !== null && !f.name.startsWith('.'))
    .slice(0, MAX_PHOTOS)

  const images: ProofImage[] = []
  for (const file of files) {
    const { data: blob, error } = await admin.storage.from('proofs').download(`${prefix}/${file.name}`)
    if (error || !blob) return { storageError: error?.message ?? `Could not read ${file.name}.` }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    images.push({ media_type: mediaTypeFor(file.name, blob.type), data: toBase64(bytes) })
  }
  return { images }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return fail(405, 'bad_request', 'POST only.')

  // --- config ---------------------------------------------------------------
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) {
    return fail(
      500,
      'not_configured',
      'This project has no ANTHROPIC_API_KEY set on the verify-proof function, so nothing can be verified yet. See supabase/PROOF-SETUP.md.',
    )
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // --- who is asking --------------------------------------------------------
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return fail(401, 'unauthorized', 'Sign in again — this request carried no session.')
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  const user = userData?.user
  if (userError || !user) {
    return fail(401, 'unauthorized', 'Your session has expired. Sign in again.')
  }

  // Everything past this point writes with the service key, which bypasses RLS.
  // Ownership is therefore enforced by hand, on every query, with
  // .eq('user_id', user.id) — there is no policy underneath to catch a miss.
  const admin = createClient(supabaseUrl, serviceKey)

  // --- input ----------------------------------------------------------------
  let body: { task_id?: unknown; followup_answer?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'bad_request', 'Expected a JSON body.')
  }
  const taskId = typeof body.task_id === 'string' ? body.task_id : ''
  if (!taskId) return fail(400, 'bad_request', 'task_id is required.')
  const rawAnswer = typeof body.followup_answer === 'string' ? body.followup_answer.trim() : ''
  const isFollowup = rawAnswer.length > 0

  // --- the task -------------------------------------------------------------
  const { data: task, error: taskError } = await admin
    .from('tasks')
    .select('id, user_id, title, tier, status, proof_hint, verification_verdict, followup_question')
    .eq('id', taskId)
    .eq('user_id', user.id)
    .maybeSingle<TaskRow>()
  if (taskError) return fail(500, 'db_error', `Could not read that task: ${taskError.message}`)
  if (!task) return fail(404, 'task_not_found', 'That task does not exist on your account.')
  if (task.status === 'verified') {
    return fail(409, 'already_verified', 'That task is already done.')
  }
  if (task.status === 'cancelled') {
    return fail(409, 'wrong_state', 'That task was cancelled.')
  }
  if (isFollowup && !(task.verification_verdict === 'needs_followup' && task.followup_question)) {
    return fail(409, 'wrong_state', 'There is no follow-up question waiting on that task.')
  }

  // --- the daily guard ------------------------------------------------------
  // Counted before the API call, so a burst of taps cannot each get one in
  // flight before any of them has been logged. Serialised writes would need a
  // transaction; three-a-day does not warrant one, and the overshoot is at most
  // the number of simultaneous taps, which on one phone is one.
  //
  // The count is only half of it — the row that makes the next count correct is
  // claimed below, before the API call, and a failure to write it stops the
  // call. See "claim the attempt".
  const { count, error: countError } = await admin
    .from('verification_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId)
    .eq('user_id', user.id)
    .gte('day', new Date().toISOString().slice(0, 10))
  if (countError) {
    return fail(500, 'db_error', `Could not check today's attempts: ${countError.message}`)
  }
  const used = count ?? 0
  if (used >= MAX_ATTEMPTS_PER_DAY) {
    return fail(
      429,
      'rate_limited',
      `That task has used all ${MAX_ATTEMPTS_PER_DAY} verification attempts for today. It resets tomorrow.`,
      { attempts_used: used, attempts_remaining: 0 },
    )
  }

  // --- the photos -----------------------------------------------------------
  const loaded = await loadPhotos(admin, user.id, taskId)
  if ('storageError' in loaded) {
    return fail(
      502,
      'storage_error',
      `Your photos could not be read back: ${loaded.storageError}. Nothing was verified — try submitting again.`,
    )
  }
  if (loaded.images.length === 0) {
    return fail(400, 'no_photos', 'No photos were found for that task. Take one and submit again.')
  }

  // --- claim the attempt ----------------------------------------------------
  // Written BEFORE the API call, and the call is refused if it does not land.
  //
  // The previous shape logged the attempt afterwards and never looked at the
  // result. Anything that broke only the insert — a constraint, a transient
  // failure, a policy change — left the count frozen while the calls kept
  // going, which turns a cost ceiling into a cost ceiling-shaped comment. The
  // guard's whole job is bounding spend, so an attempt that cannot be counted
  // is an attempt that does not happen.
  //
  // Deliberately after the photos are loaded: a storage failure is not a
  // verification attempt and must not cost one. Deliberately before the API
  // call: everything from here on may be billed, so it counts either way, and
  // the row is filled in with the outcome once there is one.
  const { data: claimed, error: claimError } = await admin
    .from('verification_attempts')
    .insert({
      user_id: user.id,
      task_id: taskId,
      photo_count: loaded.images.length,
      is_followup: isFollowup,
      reason: 'started',
    })
    .select('id')
    .single()
  if (claimError || !claimed) {
    return fail(
      500,
      'db_error',
      `Today's attempt could not be recorded, so nothing was sent for verification: ${
        claimError?.message ?? 'the attempt log returned no row'
      }`,
    )
  }
  const attemptId = claimed.id as string

  /** Fill in the claimed row. Never fatal — the attempt is already counted. */
  const recordOutcome = async (verdict: string | null, reason: string) => {
    await admin.from('verification_attempts').update({ verdict, reason }).eq('id', attemptId)
  }

  // --- ask Claude -----------------------------------------------------------
  const allowed: Verdict[] = isFollowup
    ? ['verified', 'rejected']
    : ['verified', 'rejected', 'needs_followup']

  const lines = [
    `Task: ${task.title}`,
    `Tier: ${task.tier} (1 = major academic work, 2 = standard homework, 3 = quick logistics)`,
  ]
  if (task.proof_hint) lines.push(`What proof should look like: ${task.proof_hint}`)
  lines.push(`Photos attached: ${loaded.images.length}`)
  if (isFollowup) {
    lines.push('')
    lines.push(`You already looked at these photos and asked: "${task.followup_question}"`)
    lines.push(`They answered: "${rawAnswer}"`)
    lines.push(
      'Decide now: verified or rejected. Accept the answer unless it plainly contradicts the photos or shows they did not do the work.',
    )
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey, timeout: 60_000, maxRetries: 1 })

  let message: Anthropic.Message
  try {
    message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      // Forced, so the answer comes back as a structured tool input rather than
      // prose that has to be scraped for JSON.
      tools: [verdictTool(allowed)],
      tool_choice: { type: 'tool', name: 'record_verdict' },
      messages: [
        {
          role: 'user',
          content: [
            ...loaded.images.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
            })),
            { type: 'text' as const, text: lines.join('\n') },
          ],
        },
      ],
    })
  } catch (e) {
    const err = e as { status?: number; message?: string }
    // The attempt is already claimed and already counts against the three: it
    // is a call that may well have been billed, which is the honest reading of
    // a cost guard. All that is left is to say what became of it.
    await recordOutcome(null, `api_error: ${err.message ?? 'unknown'}`)
    return fail(
      502,
      'api_error',
      err.status === 429
        ? 'Claude is rate-limiting this project right now. Nothing was verified — try again in a minute.'
        : `Claude could not be reached, so nothing was verified: ${err.message ?? 'unknown error'}`,
      { attempts_used: used + 1, attempts_remaining: MAX_ATTEMPTS_PER_DAY - (used + 1) },
    )
  }

  const result = readVerdict(message, allowed)
  if (!result || (result.verdict === 'needs_followup' && !result.followup_question)) {
    await recordOutcome(null, 'unreadable_verdict')
    return fail(
      502,
      'unreadable_verdict',
      'Claude answered in a shape this app could not read, so nothing was verified. Try submitting again.',
      { attempts_used: used + 1, attempts_remaining: MAX_ATTEMPTS_PER_DAY - (used + 1) },
    )
  }

  // --- write it down --------------------------------------------------------
  const { error: writeError } = await admin
    .from('tasks')
    .update({
      verification_verdict: result.verdict,
      verification_notes: result.reason,
      followup_question: result.verdict === 'needs_followup' ? result.followup_question : null,
      followup_answer: isFollowup ? rawAnswer : null,
      verified_by_ai_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('user_id', user.id)
  if (writeError) {
    await recordOutcome(null, `verdict_not_saved: ${writeError.message}`)
    return fail(
      500,
      'db_error',
      `Claude answered but the verdict could not be saved: ${writeError.message}. Nothing was credited.`,
    )
  }

  await recordOutcome(result.verdict, result.reason)

  return ok({
    verdict: result.verdict,
    reason: result.reason,
    followup_question: result.followup_question,
    attempts_used: used + 1,
    attempts_remaining: MAX_ATTEMPTS_PER_DAY - (used + 1),
  })
})
