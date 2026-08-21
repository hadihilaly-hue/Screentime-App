/**
 * Proof submission: photos into Storage, task id into the verify-proof Edge
 * Function, verdict back out — and, only on a verdict of verified, the
 * existing completeTask() credit path.
 *
 * The shape of this file is one rule: **nothing here ever decides a task**.
 * The verdict comes from the Edge Function, which is the only thing holding the
 * Anthropic key, and the minutes come from completeTask(), which is the same
 * compare-and-swap pair it has always been. This module carries bytes and
 * answers between the two, and every way it can fail has its own name so the
 * screen can say what actually happened. A storage outage is not a rejection.
 * An offline phone is not a pass.
 */

import { requireClient, supabaseAnonKey, supabaseUrl } from './supabase'
import { completeTask, getTask, type Task, type Verdict } from './db'

/** Spec section 4.4. */
export const MAX_PHOTOS = 3

// There is deliberately no MAX_ATTEMPTS_PER_DAY here. The limit lives in
// supabase/functions/verify-proof/index.ts, which is the only thing that
// enforces it; the screens render the `attempts_remaining` that comes back with
// each verdict. A copy of the number on this side could only ever go stale, and
// a stale copy of a limit is worse than no copy, because it reads as authority.

const BUCKET = 'proofs'

/**
 * `{user_id}/{task_id}/{n}.jpg`. The first path segment is what the storage
 * policies compare against auth.uid(), so the folder layout is the access rule.
 */
function folder(userId: string, taskId: string): string {
  return `${userId}/${taskId}`
}

/** What the UI renders. Every branch is a distinct screen. */
export type ProofOutcome =
  | {
      kind: 'verified'
      reason: string
      /** Minutes actually credited. 0 is legitimate — the daily cap. */
      granted: number
      /**
       * Set when Claude verified the task but the credit that follows did not
       * land. The task is genuinely verified; the minutes are genuinely not
       * there yet. Saying so beats showing either half alone.
       */
      creditError?: string
      /**
       * True when this was reconstructed from the task row on a reload rather
       * than produced by a submission just now. The screen then reports the
       * verdict without claiming a minute figure it does not actually know.
       */
      restored?: boolean
      attemptsRemaining: number | null
    }
  | { kind: 'rejected'; reason: string; attemptsRemaining: number | null }
  | { kind: 'needs_followup'; question: string; reason: string; attemptsRemaining: number | null }
  | {
      kind: 'error'
      /** Machine-readable, from the function or from this file. */
      code: string
      message: string
      /** True when retrying the same photos is the sensible next move. */
      retryable: boolean
    }

interface FunctionReply {
  ok?: boolean
  verdict?: Verdict
  reason?: string
  followup_question?: string | null
  attempts_used?: number
  attempts_remaining?: number
  error?: string
  message?: string
}

/**
 * Submission needs the network, and it says so rather than pretending.
 *
 * There is no offline queue on purpose: a queued proof is a task that looks
 * submitted, sits on the phone, and gets verified hours later against a photo
 * whose moment has passed — and in the meantime the balance is wrong in a way
 * nothing on screen explains. Requiring a connection makes the failure
 * immediate and legible instead.
 *
 * navigator.onLine only ever proves the negative (no interface at all). A
 * captive portal or a dead connection still reads as online, so the real check
 * is the fetch below failing; this is just the early, clearer message.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

const OFFLINE: ProofOutcome = {
  kind: 'error',
  code: 'offline',
  message:
    'You are offline. Verification needs a connection — nothing is queued, so submit again once you are back on Wi-Fi or data.',
  retryable: true,
}

/**
 * Remove whatever is already in this task's folder.
 *
 * Called before every upload, and it matters for one case: re-submitting fewer
 * photos than last time. The Edge Function reads the folder rather than a list
 * the client sends it (a list the client sends is a list the client can point
 * at someone else's better photos), so a leftover third file from a rejected
 * attempt would ride along with a new two-photo one.
 */
async function clearFolder(userId: string, taskId: string): Promise<void> {
  const db = requireClient()
  const prefix = folder(userId, taskId)
  const { data, error } = await db.storage.from(BUCKET).list(prefix, { limit: 50 })
  if (error) throw new Error(`Could not check your previous photos: ${error.message}`)
  const paths = (data ?? []).filter((f) => f.id !== null).map((f) => `${prefix}/${f.name}`)
  if (paths.length === 0) return
  const { error: removeError } = await db.storage.from(BUCKET).remove(paths)
  if (removeError) {
    throw new Error(`Could not clear your previous photos: ${removeError.message}`)
  }
}

/** Upload in order, returning the storage paths written. */
async function upload(userId: string, taskId: string, photos: Blob[]): Promise<string[]> {
  const db = requireClient()
  const prefix = folder(userId, taskId)
  const paths: string[] = []
  for (let i = 0; i < photos.length; i++) {
    const path = `${prefix}/${i + 1}.jpg`
    const { error } = await db.storage
      .from(BUCKET)
      .upload(path, photos[i], { contentType: 'image/jpeg', upsert: true })
    if (error) throw new Error(`Photo ${i + 1} did not upload: ${error.message}`)
    paths.push(path)
  }
  return paths
}

/**
 * Call the Edge Function.
 *
 * fetch rather than supabase.functions.invoke(), because invoke() turns a
 * non-2xx reply into an error object with the body tucked inside it, and the
 * body is the whole point here: "storage could not be read", "you have used
 * today's three attempts" and "Claude is down" are three different screens, and
 * they arrive as 502, 429 and 502 with different codes.
 */
async function callVerify(body: Record<string, unknown>): Promise<FunctionReply | ProofOutcome> {
  const db = requireClient()
  const {
    data: { session },
  } = await db.auth.getSession()
  if (!session) {
    return {
      kind: 'error',
      code: 'unauthorized',
      message: 'Your session has expired. Reload and sign in again.',
      retryable: false,
    }
  }

  let res: Response
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/verify-proof`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    return OFFLINE
  }

  let reply: FunctionReply
  try {
    reply = (await res.json()) as FunctionReply
  } catch {
    return {
      kind: 'error',
      code: 'unreadable_response',
      // A deployed-but-broken function, or a project with no verify-proof at
      // all, lands here. Both are setup problems, and pretending otherwise
      // would mean showing a verdict nothing produced.
      message: `The verification service answered with something this app could not read (HTTP ${res.status}). Nothing was verified.`,
      retryable: false,
    }
  }

  if (!res.ok || reply.ok !== true) {
    return {
      kind: 'error',
      code: reply.error ?? `http_${res.status}`,
      message: reply.message ?? `Verification failed (HTTP ${res.status}). Nothing was verified.`,
      retryable: res.status >= 500 || res.status === 429,
    }
  }
  return reply
}

function isOutcome(x: FunctionReply | ProofOutcome): x is ProofOutcome {
  return 'kind' in x
}

/**
 * Turn a successful reply into an outcome, crediting when it says verified.
 *
 * The credit is the untouched path: completeTask claims the task with its own
 * compare-and-swap and then credits the balance with another. If it throws, the
 * verdict still stands and the error is carried on the outcome rather than
 * swallowed — VerificationResult offers to run the credit again.
 */
async function settle(reply: FunctionReply, task: Task): Promise<ProofOutcome> {
  // null, not 0, when the field is missing. The screens omit the line entirely
  // for null; defaulting to 0 would render "No verification attempts left on
  // this task today" — an alarming claim about a number we do not have.
  const remaining = reply.attempts_remaining ?? null
  const reason = reply.reason ?? ''

  if (reply.verdict === 'rejected') return { kind: 'rejected', reason, attemptsRemaining: remaining }

  if (reply.verdict === 'needs_followup') {
    return {
      kind: 'needs_followup',
      question: reply.followup_question ?? '',
      reason,
      attemptsRemaining: remaining,
    }
  }

  if (reply.verdict === 'verified') {
    try {
      const granted = await completeTask(task.user_id, task)
      return { kind: 'verified', reason, granted, attemptsRemaining: remaining }
    } catch (e) {
      return {
        kind: 'verified',
        reason,
        granted: 0,
        creditError: (e as Error).message,
        attemptsRemaining: remaining,
      }
    }
  }

  return {
    kind: 'error',
    code: 'unreadable_verdict',
    message: 'The verification came back without a verdict. Nothing was decided.',
    retryable: true,
  }
}

/**
 * Upload the photos and get a verdict.
 *
 * `task` is re-read from the database rather than trusted from the caller's
 * render, because completeTask() is about to be handed it and the tier it
 * carries decides the minutes.
 */
export async function submitProof(taskId: string, photos: Blob[]): Promise<ProofOutcome> {
  if (photos.length === 0) {
    return { kind: 'error', code: 'no_photos', message: 'Take at least one photo first.', retryable: false }
  }
  if (isOffline()) return OFFLINE

  let task: Task | null
  try {
    task = await getTask(taskId)
  } catch (e) {
    return { kind: 'error', code: 'db_error', message: (e as Error).message, retryable: true }
  }
  if (!task) {
    return { kind: 'error', code: 'task_not_found', message: 'That task no longer exists.', retryable: false }
  }
  if (task.status === 'verified') {
    return {
      kind: 'error',
      code: 'already_verified',
      message: 'That task is already done. Reload to see where the minutes landed.',
      retryable: false,
    }
  }

  try {
    await clearFolder(task.user_id, taskId)
    const paths = await upload(task.user_id, taskId, photos.slice(0, MAX_PHOTOS))
    // Best-effort record of what was sent. The Edge Function reads the folder,
    // not this column, so a failure here costs the weekly review a detail and
    // costs the verification nothing — which is why it is not allowed to stop
    // the submission.
    try {
      const db = requireClient()
      await db.from('tasks').update({ proof_urls: paths }).eq('id', taskId)
    } catch {
      // Deliberately ignored; see above.
    }
  } catch (e) {
    return {
      kind: 'error',
      code: 'storage_error',
      message: `${(e as Error).message} Nothing was verified — try again.`,
      retryable: true,
    }
  }

  const reply = await callVerify({ task_id: taskId })
  if (isOutcome(reply)) return reply
  return settle(reply, task)
}

/** Send the typed answer to a follow-up question back for a final verdict. */
export async function answerFollowup(taskId: string, answer: string): Promise<ProofOutcome> {
  const trimmed = answer.trim()
  if (!trimmed) {
    return { kind: 'error', code: 'no_answer', message: 'Type an answer first.', retryable: false }
  }
  if (isOffline()) return OFFLINE

  let task: Task | null
  try {
    task = await getTask(taskId)
  } catch (e) {
    return { kind: 'error', code: 'db_error', message: (e as Error).message, retryable: true }
  }
  if (!task) {
    return { kind: 'error', code: 'task_not_found', message: 'That task no longer exists.', retryable: false }
  }

  const reply = await callVerify({ task_id: taskId, followup_answer: trimmed })
  if (isOutcome(reply)) return reply
  return settle(reply, task)
}

/**
 * Retry only the credit, for a task Claude verified whose minutes did not land.
 *
 * No API call and no attempt is spent: the verdict is already on the row, and
 * this is the same completeTask() the successful path runs.
 */
export async function claimVerifiedMinutes(taskId: string): Promise<ProofOutcome> {
  const task = await getTask(taskId)
  if (!task) {
    return { kind: 'error', code: 'task_not_found', message: 'That task no longer exists.', retryable: false }
  }
  if (task.verification_verdict !== 'verified') {
    return {
      kind: 'error',
      code: 'wrong_state',
      message: 'That task has not been verified, so there is nothing to claim.',
      retryable: false,
    }
  }
  try {
    const granted = await completeTask(task.user_id, task)
    return {
      kind: 'verified',
      reason: task.verification_notes ?? '',
      granted,
      attemptsRemaining: null,
    }
  } catch (e) {
    return {
      kind: 'verified',
      reason: task.verification_notes ?? '',
      granted: 0,
      creditError: (e as Error).message,
      attemptsRemaining: null,
    }
  }
}

/**
 * Rebuild an outcome from the task row alone.
 *
 * Reloading /verification/:id — or opening it from a home-screen shortcut —
 * arrives with no router state. The row still knows what was decided.
 */
export function outcomeFromTask(task: Task): ProofOutcome | null {
  if (task.status === 'verified') {
    return {
      kind: 'verified',
      reason: task.verification_notes ?? '',
      granted: 0,
      restored: true,
      attemptsRemaining: null,
    }
  }
  if (task.verification_verdict === 'verified') {
    // Verified but never credited — the credit failed, or the tab closed
    // between the two. Reported as such, with the claim button.
    return {
      kind: 'verified',
      reason: task.verification_notes ?? '',
      granted: 0,
      creditError: 'The minutes for this task were never added.',
      restored: true,
      attemptsRemaining: null,
    }
  }
  if (task.verification_verdict === 'rejected') {
    return { kind: 'rejected', reason: task.verification_notes ?? '', attemptsRemaining: null }
  }
  if (task.verification_verdict === 'needs_followup' && task.followup_question) {
    return {
      kind: 'needs_followup',
      question: task.followup_question,
      reason: task.verification_notes ?? '',
      attemptsRemaining: null,
    }
  }
  return null
}
