import { adminClient, anthropic, MODEL, parseJson, requireUser, textOf } from '../_shared/clients.ts'
import { corsHeaders, fail, json } from '../_shared/cors.ts'

const SYSTEM = `You verify whether photo evidence shows a completed task. The user is a
motivated student who will sometimes try to pass off partial or old work.
Be fair but skeptical.
You receive: the task title, its proof_hint, and 1-3 photos.
Decide:
- VERIFIED: evidence clearly matches the task. Handwritten work should look
  substantive, not token (a page with 2 pencil marks is not an annotated page).
- FOLLOW_UP: plausible but you want confirmation the user actually did the
  work. Ask ONE specific question answerable only by someone who did it
  (e.g. "What did you get for question 14?" or "What was the passage about?").
- REJECTED: evidence doesn't match, looks incomplete, or is unreadable.
  Give a one-sentence reason and what a passing photo would show.

Always also fill in content_question: one specific question about the visible
content of the work, answerable only by someone who actually did it. Fill this
in even when your verdict is VERIFIED — it is held in reserve for spot checks.
Set follow_up_question to your question when the verdict is FOLLOW_UP, and to
an empty string otherwise.`

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['VERIFIED', 'FOLLOW_UP', 'REJECTED'] },
    reason: { type: 'string' },
    // Empty string rather than null — a plain string type is the most widely
    // supported shape for constrained JSON output.
    follow_up_question: { type: 'string' },
    content_question: { type: 'string' },
  },
  required: ['verdict', 'reason', 'follow_up_question', 'content_question'],
  additionalProperties: false,
}

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['VERIFIED', 'REJECTED'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
}

const FINAL_SYSTEM = `${SYSTEM}

You have already asked the student one follow-up question and they have
answered. Weigh the answer against what the photos actually show. A vague,
evasive, or contradicted answer means REJECTED. Give a final verdict now:
VERIFIED or REJECTED only.`

/** Upload-bypass guard: the photo must have been taken moments ago. */
const MAX_CAPTURE_AGE_MS = 2 * 60 * 1000

type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

function mediaTypeFor(path: string): string {
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function loadImages(
  db: ReturnType<typeof adminClient>,
  paths: string[],
): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = []
  for (const path of paths.slice(0, 3)) {
    const { data, error } = await db.storage.from('proofs').download(path)
    if (error || !data) throw new Error(`Could not read proof photo: ${error?.message}`)
    const bytes = new Uint8Array(await data.arrayBuffer())
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaTypeFor(path), data: toBase64(bytes) },
    })
  }
  return blocks
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const user = await requireUser(req)
    const body = await req.json()
    const taskId: string = body.task_id
    const mode: 'photo' | 'follow_up' | 'self_report' = body.mode ?? 'photo'
    if (!taskId) return fail('task_id is required')

    const db = adminClient()
    const { data: task, error: taskErr } = await db
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    if (taskErr || !task) return fail('Task not found', 404)
    if (task.user_id !== user.id) return fail('Not your task', 403)
    if (task.status === 'verified') return fail('That task is already verified.')

    // --- self-report path: no photo exists to look at -----------------------
    if (mode === 'self_report') {
      if (!task.self_report_only) {
        return fail('This task needs a photo.')
      }
      // Logged as MANUAL, not VERIFIED: no photo was ever looked at. The
      // weekly review counts these separately from proofs Claude actually saw.
      const { data: credit, error } = await db.rpc('credit_self_reported_task', {
        p_task_id: taskId,
        p_reason: 'Self-report task — no photo evidence required.',
      })
      if (error) return fail(error.message)
      return json({ verdict: 'VERIFIED', reason: 'Logged as self-reported.', credit })
    }

    // --- follow-up path: second and final verdict ---------------------------
    if (mode === 'follow_up') {
      const answer: string = (body.follow_up_answer ?? '').trim()
      if (!answer) return fail('Answer the question first.')
      if (!task.follow_up_question) return fail('There is no open follow-up on this task.')

      const images = await loadImages(db, task.proof_urls ?? [])
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1000,
        system: FINAL_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: FINAL_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: [
              ...images,
              {
                type: 'text',
                text: [
                  `Task: ${task.title}`,
                  `proof_hint: ${task.proof_hint ?? '(none)'}`,
                  `Your follow-up question: ${task.follow_up_question}`,
                  `The student's answer: ${answer.slice(0, 2000)}`,
                ].join('\n'),
              },
            ],
          },
        ],
      })

      const result = parseJson<{ verdict: 'VERIFIED' | 'REJECTED'; reason: string }>(
        textOf(response.content),
      )

      // Was the question a random spot check rather than a real doubt? Carry
      // that through so the weekly review can count spot checks honestly.
      const { data: priorAttempt } = await db
        .from('verification_attempts')
        .select('forced_follow_up')
        .eq('task_id', taskId)
        .eq('verdict', 'FOLLOW_UP')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const wasSpotCheck = priorAttempt?.forced_follow_up ?? false

      if (result.verdict === 'VERIFIED') {
        const { data: credit, error } = await db.rpc('credit_verified_task', {
          p_task_id: taskId,
          p_reason: result.reason,
          p_proof_urls: task.proof_urls ?? [],
          p_forced_follow_up: wasSpotCheck,
        })
        if (error) return fail(error.message)
        await db.from('tasks').update({ follow_up_answer: answer }).eq('id', taskId)
        return json({ verdict: 'VERIFIED', reason: result.reason, credit })
      }

      const { error } = await db.rpc('log_verification_attempt', {
        p_task_id: taskId,
        p_verdict: 'REJECTED',
        p_reason: result.reason,
        p_follow_up_question: task.follow_up_question,
        p_follow_up_answer: answer,
        p_proof_urls: task.proof_urls ?? [],
        p_forced_follow_up: wasSpotCheck,
      })
      if (error) return fail(error.message)
      return json({ verdict: 'REJECTED', reason: result.reason })
    }

    // --- photo path: first verdict ------------------------------------------
    const paths: string[] = Array.isArray(body.proof_paths) ? body.proof_paths : []
    if (paths.length < 1) return fail('Take at least one photo.')
    if (paths.length > 3) return fail('Three photos maximum.')
    if (!paths.every((p) => typeof p === 'string' && p.startsWith(`${user.id}/`))) {
      return fail('Those photos are not yours.', 403)
    }

    const capturedAt = Date.parse(body.captured_at ?? '')
    if (Number.isNaN(capturedAt)) return fail('Missing capture timestamp.')
    const age = Date.now() - capturedAt
    if (age > MAX_CAPTURE_AGE_MS) {
      return fail('That photo was taken more than 2 minutes ago. Take a fresh one in the app.')
    }
    if (age < -30_000) return fail('Your device clock is ahead of the server. Fix it and retry.')

    const images = await loadImages(db, paths)
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            ...images,
            {
              type: 'text',
              text: [
                `Task: ${task.title}`,
                `proof_hint: ${task.proof_hint ?? '(none)'}`,
                `Tier: ${task.tier}`,
              ].join('\n'),
            },
          ],
        },
      ],
    })

    const result = parseJson<{
      verdict: 'VERIFIED' | 'FOLLOW_UP' | 'REJECTED'
      reason: string
      follow_up_question: string
      content_question: string
    }>(textOf(response.content))

    // Random spot check. Even a clean VERIFIED gets questioned some of the
    // time — unpredictability is what makes faking expensive.
    const { data: cfg } = await db
      .from('app_config')
      .select('follow_up_rate')
      .eq('user_id', user.id)
      .maybeSingle()
    const rate = cfg?.follow_up_rate ?? 0.25
    const forced = result.verdict === 'VERIFIED' && Math.random() < rate

    if (forced || result.verdict === 'FOLLOW_UP') {
      const question =
        (forced ? result.content_question : result.follow_up_question) ||
        result.content_question ||
        'What was the hardest part of this, specifically?'
      const { error } = await db.rpc('log_verification_attempt', {
        p_task_id: taskId,
        p_verdict: 'FOLLOW_UP',
        p_reason: forced ? 'Spot check.' : result.reason,
        p_follow_up_question: question,
        p_follow_up_answer: null,
        p_proof_urls: paths,
        p_forced_follow_up: forced,
      })
      if (error) return fail(error.message)
      return json({
        verdict: 'FOLLOW_UP',
        reason: forced ? 'Spot check.' : result.reason,
        follow_up_question: question,
      })
    }

    if (result.verdict === 'VERIFIED') {
      const { data: credit, error } = await db.rpc('credit_verified_task', {
        p_task_id: taskId,
        p_reason: result.reason,
        p_proof_urls: paths,
        p_forced_follow_up: false,
      })
      if (error) return fail(error.message)
      return json({ verdict: 'VERIFIED', reason: result.reason, credit })
    }

    const { error } = await db.rpc('log_verification_attempt', {
      p_task_id: taskId,
      p_verdict: 'REJECTED',
      p_reason: result.reason,
      p_follow_up_question: null,
      p_follow_up_answer: null,
      p_proof_urls: paths,
    })
    if (error) return fail(error.message)
    return json({ verdict: 'REJECTED', reason: result.reason })
  } catch (err) {
    if (err instanceof Response) return fail(await err.text(), err.status)
    console.error('verify-proof failed', err)
    return fail('Verification is down. Try again in a minute.', 502)
  }
})
