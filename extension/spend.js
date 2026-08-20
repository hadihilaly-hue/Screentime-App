// Starting a session from the block page (spec section 3A).
//
// This is the only place a session is created now — the web app's dashboard no
// longer starts one. The write path mirrors src/lib/db.ts startSession exactly:
// minutes are deducted first and the session row is inserted second, so a
// reload mid-start cannot buy the same minutes twice.

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
  // `before` and `minutes` ride along so the caller can undo the whole thing if
  // the block never actually lifts — see rollbackSession.
  return { session: row[0], endsAt: Math.min(endsAt, phase.endsAt), before, minutes }
}

/**
 * Undo a session that was paid for but never let you in.
 *
 * The order cannot be fixed by rearranging it: the worker only unlocks a domain
 * once a session row exists, so the spend genuinely has to happen before the
 * rules can drop. That leaves a window where the minutes are gone and the rules
 * write then fails, and the honest answer to "charged without access" there is
 * to put it back — end the session so it cannot unlock anything later, and
 * refund by the same compare-and-swap the insert path uses, so a refund cannot
 * hand back minutes something else has since spent.
 *
 * Returns a list of what could not be undone; empty means the tap left no trace.
 */
export async function rollbackSession(started) {
  const { session, before, minutes } = started
  const errors = []

  try {
    const rows = await patch(`sessions?id=eq.${session.id}`, { ended_at: new Date().toISOString() })
    if (!rows || rows.length === 0) errors.push('the session could not be closed')
  } catch (e) {
    errors.push(`the session could not be closed (${e.message})`)
  }

  const refunded = await swapAvailable(session.user_id, before - minutes, before).catch(() => false)
  if (!refunded) errors.push(`the ${minutes} minutes could not be refunded`)

  return errors
}
