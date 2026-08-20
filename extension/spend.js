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

async function setAvailable(userId, minutes) {
  const rows = await patch(
    `balances?user_id=eq.${userId}&date=eq.${todayISO()}`,
    { minutes_available: minutes, updated_at: new Date().toISOString() },
  )
  // PostgREST answers 2xx for an UPDATE that RLS or the filter reduced to zero
  // rows, so the rows are checked rather than the status — otherwise a session
  // could be granted against a balance that was never actually debited.
  if (!rows || rows.length === 0) throw new Error('Could not update your balance.')
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

  const available = await readBalance()
  if (available === null) throw new Error('Sign in from the extension icon first.')
  if (available < minutes) throw new Error(`Only ${available} minutes available.`)

  await setAvailable(stored.user_id, available - minutes)

  let row
  try {
    row = await insert('sessions', {
      user_id: stored.user_id,
      date: todayISO(),
      app_name: site.apps[0],
      minutes,
      started_at: new Date().toISOString(),
    })
  } catch (e) {
    // The minutes are already gone but there is no session to show for them.
    // Put them back rather than silently charging for nothing; if the refund
    // itself fails, say both things happened.
    try {
      await setAvailable(stored.user_id, available)
    } catch {
      throw new Error(`${e.message} — and the ${minutes} minutes could not be refunded.`)
    }
    throw e
  }

  if (!row || row.length === 0) {
    await setAvailable(stored.user_id, available)
    throw new Error('The session row was rejected. No minutes were spent.')
  }

  const endsAt = new Date(row[0].started_at).getTime() + minutes * 60_000
  return { session: row[0], endsAt: Math.min(endsAt, phase.endsAt) }
}
