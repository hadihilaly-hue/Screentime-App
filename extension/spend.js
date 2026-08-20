// Starting a session from the block page (spec section 3A).
//
// This is the only place a session is created now — the web app's dashboard no
// longer starts one. The write path mirrors src/lib/db.ts startSession exactly:
// minutes are deducted first and the session row is inserted second, so a
// reload mid-start cannot buy the same minutes twice. That order is a chosen
// tradeoff rather than a requirement — only the insert has to precede the rules
// drop — and its price is a window where the minutes are gone and the next step
// fails. A rejected insert is refunded here, because at that point nothing has
// been created and the undo is one write. A rejected *rules write* is not: see
// closeRefusedSession.

import { query, insert, patch, todayISO, getSession } from './supabase.js'
import { canSpend, phaseAt } from './schedule.js'
import { isAlwaysAllowed } from './always-allowed.js'

/** Today's spendable minutes, or null when signed out. */
export async function readBalance() {
  const rows = await query(`balances?select=minutes_available&date=eq.${todayISO()}`)
  if (rows === null) return null
  return rows[0]?.minutes_available ?? 0
}

/**
 * Compare-and-swap on the balance: write `to`, but only if it is still `from`.
 *
 * The filter carries the value that was read, so PostgREST updates zero rows if
 * anything moved in between and the caller can see that it lost. Two block
 * pages tapped in the same second used to be able to read 20 each and start 20
 * minutes each — both writes landed, neither went negative, and 40 minutes came
 * out of a 20 minute balance. Returns whether the swap took.
 *
 * This narrows the window to the round trip; it does not close it. The real fix
 * is doing the arithmetic in Postgres, which is a schema change and out of
 * scope here — src/lib/db.ts still has the same read-modify-write.
 */
async function swapAvailable(userId, from, to) {
  const rows = await patch(
    `balances?user_id=eq.${userId}&date=eq.${todayISO()}&minutes_available=eq.${from}`,
    { minutes_available: to, updated_at: new Date().toISOString() },
  )
  // PostgREST answers 2xx for an UPDATE that RLS or the filter reduced to zero
  // rows, so the rows are checked rather than the status — otherwise a session
  // could be granted against a balance that was never actually debited.
  return Boolean(rows && rows.length > 0)
}

/**
 * Deduct `minutes`, re-reading and retrying once if the balance moved.
 *
 * One retry, not a loop: a second failure means something else is actively
 * spending, and quietly winning a race for the user is worse than telling them
 * to tap again. Returns the balance as it was before the deduction, which is
 * what a refund has to put back.
 */
async function deduct(userId, minutes) {
  const seen = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const available = await readBalance()
    if (available === null) throw new Error('Sign in from the extension icon first.')
    if (available < minutes) throw new Error(`Only ${available} minutes available.`)
    if (await swapAvailable(userId, available, available - minutes)) return available
    seen.push(available)
  }

  // Two refused swaps with the balance sitting at the same value both times is
  // not a race — nothing moved. The row exists and is readable but will not
  // take this write, which in practice means the extension is signed in as a
  // different account than the row belongs to. "Try again" is advice that would
  // never work, so say the thing that would.
  if (seen[0] === seen[1]) {
    throw new Error(
      'Your balance would not accept the write. Check the extension is signed in as the same account as the app, then reload it.',
    )
  }
  throw new Error('Your balance changed while that was starting. Try again.')
}

/**
 * Spend `minutes` and open `site`.
 *
 * Refuses outside the spend window, refuses an always-allowed site (which is
 * never metered at all), and refuses a balance that cannot cover it. Returns
 * when the unlock runs out — capped at the end of the window, because midnight
 * closes the window whatever the session says.
 */
export async function startSession(site, minutes) {
  const phase = phaseAt()
  if (!canSpend()) throw new Error('Sessions can only be started in the spend window.')
  if (isAlwaysAllowed(site)) throw new Error('That app is always allowed and is never metered.')
  if (!site?.apps?.length) throw new Error('That site has no app_name configured.')

  const stored = await getSession()
  if (!stored?.user_id) throw new Error('Sign in from the extension icon first.')

  const before = await deduct(stored.user_id, minutes)

  let row
  try {
    row = await insert('sessions', {
      user_id: stored.user_id,
      date: todayISO(),
      app_name: site.apps[0],
      minutes,
      started_at: new Date().toISOString(),
    })
    if (!row || row.length === 0) throw new Error('The session row was rejected.')
  } catch (e) {
    // The minutes are already gone but there is no session to show for them.
    // Put them back rather than silently charging for nothing. The refund is a
    // swap too, from the value this call wrote — if something else has spent in
    // the meantime, refunding to `before` would hand back their minutes as well.
    //
    // This covers "the insert did not happen", not "the insert happened and the
    // answer was lost". A commit whose response times out lands here too, and
    // refunds minutes for a session that does exist. Closing that needs the
    // insert and the debit in one transaction, which is a schema change.
    const refunded = await swapAvailable(stored.user_id, before - minutes, before).catch(() => false)
    if (!refunded) throw new Error(`${e.message} — and the ${minutes} minutes could not be refunded.`)
    throw new Error(`${e.message} No minutes were spent.`)
  }

  const endsAt = new Date(row[0].started_at).getTime() + minutes * 60_000
  return { session: row[0], endsAt: Math.min(endsAt, phase.endsAt), minutes }
}

/** 500ms, 1s, 2s, 4s between the five attempts. */
const CLOSE_ATTEMPTS = 5
const closeBackoff = (attempt) => 500 * 2 ** (attempt - 1)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Close a session that was paid for and then not let through.
 *
 * Called on either definite refusal, and both cost the minutes: the browser
 * rejecting the rules write, and the worker's own decision leaving the domain
 * blocked when it could read the sessions table (an app_name that matches no
 * site, most often). The second is rarer and is a configuration fault rather
 * than a browser one, but the outcome for the user is identical — paid, still
 * outside — so it gets the identical, stated policy rather than a quiet
 * exception.
 *
 * **The minutes are not refunded.** Two rounds of trying to refund them
 * produced, in order, a free unlock (refunding while the row was still open
 * left a live session and a restored balance) and then a retry that could never
 * complete the one failure that persisted (having closed the row, it could not
 * re-derive that it had, so it looped forever reporting the wrong cause). The
 * refund was the source of both, and it is buying very little: a rules write
 * the browser rejects is rare, and being charged for minutes you did not get is
 * recoverable by finishing another task. A free unlock is not recoverable — it
 * is the exact thing the schedule exists to prevent — so the policy is now
 * plainly one-sided. Overcharge on failure, never underlock.
 *
 * That leaves one job, which is worth retrying because it is what stops the
 * session unlocking the site later on a write that does succeed: end the row.
 * Filtered on `ended_at=is.null`, so it can only ever close a running session,
 * never rewrite the end of a finished one (spec section 7).
 *
 * Zero rows back is checked, and where it cannot be checked it is not claimed.
 * It usually means the row is not running — already closed by an earlier
 * attempt, or by the app's End Early — and the goal is the row not running, not
 * this call being the one to do it. But PostgREST answers the same way when RLS
 * filters the row, so the row is read back:
 *
 *   * visible and ended  → closed. The write was redundant, the goal is met.
 *   * visible and running → the write is being refused. Retry.
 *   * not visible        → NOT closed. There is no DELETE policy on sessions,
 *     so a missing row is never "gone" — it is "not ours to see", under the
 *     same predicate that filtered the write. The row may well still be
 *     running, and saying otherwise would be the caller's cue to tell the user
 *     it can no longer unlock anything, which is exactly what is not known.
 *
 * Returns `{ closed, attempts, error }`. Never throws.
 */
export async function closeRefusedSession(started) {
  const { session } = started
  let error = null

  for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
    try {
      const rows = await patch(`sessions?id=eq.${session.id}&ended_at=is.null`, {
        ended_at: new Date().toISOString(),
      })
      if (rows === null) {
        // Signed out. Retrying cannot fix it, and the row is still running.
        return { closed: false, attempts: attempt, error: 'signed out' }
      }
      if (rows.length > 0) return { closed: true, attempts: attempt, error: null }

      // Zero rows: confirm the row really is finished before saying so.
      const check = await query(`sessions?select=ended_at&id=eq.${session.id}`)
      if (check === null) return { closed: false, attempts: attempt, error: 'signed out' }
      if (check.length === 0) {
        // Invisible to this account, so unknowable from here — and retrying
        // cannot change whose account this is.
        return {
          closed: false,
          attempts: attempt,
          error: 'the session is not visible to this account',
        }
      }
      if (check[0].ended_at) return { closed: true, attempts: attempt, error: null }
      // Still running and the write did not take it: something is refusing us.
      error = 'the session row would not accept the close'
    } catch (e) {
      // Not every throw is an Error; String() beats rendering "undefined".
      error = String(e?.message ?? e)
    }
    if (attempt < CLOSE_ATTEMPTS) await delay(closeBackoff(attempt))
  }

  return { closed: false, attempts: CLOSE_ATTEMPTS, error }
}

