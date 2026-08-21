import { requireClient } from './supabase'
import { DAILY_CAP_MINUTES, TIER_MINUTES, isAlwaysAllowed, type Tier } from './constants'
import { todayISO } from './date'
import { canSpend } from './schedule'

export type TaskStatus = 'todo' | 'pending' | 'verified' | 'rejected' | 'cancelled'

export interface Task {
  id: string
  user_id: string
  date: string
  title: string
  tier: Tier
  status: TaskStatus
  claude_suggested_tier: Tier | null
  proof_hint: string | null
  proof_urls: string[]
  verification_notes: string | null
  created_after_confirmation: boolean
  edited_after_confirmation: boolean
  verified_at: string | null
  created_at: string
}

export interface Balance {
  user_id: string
  date: string
  minutes_available: number
  minutes_earned_total: number
  all_tasks_bonus: boolean
}

export interface AppSession {
  id: string
  user_id: string
  date: string
  app_name: string
  minutes: number
  started_at: string
  ended_at: string | null
}

export interface DailyState {
  user_id: string
  date: string
  list_confirmed: boolean
  confirmed_at: string | null
}

// --- daily state -----------------------------------------------------------

export async function getDailyState(userId: string): Promise<DailyState> {
  const db = requireClient()
  const date = todayISO()
  const { data, error } = await db
    .from('daily_state')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle()
  if (error) throw error
  return data ?? { user_id: userId, date, list_confirmed: false, confirmed_at: null }
}

export async function confirmList(userId: string): Promise<DailyState> {
  const db = requireClient()
  const { data, error } = await db
    .from('daily_state')
    .upsert(
      { user_id: userId, date: todayISO(), list_confirmed: true, confirmed_at: new Date().toISOString() },
      { onConflict: 'user_id,date' },
    )
    .select()
    .maybeSingle()

  // Verified against Postgres 16: because the update policy stops matching once
  // list_confirmed is true, an upsert onto an already-confirmed day raises
  // "new row violates row-level security policy (USING expression)" rather than
  // writing zero rows — ON CONFLICT DO UPDATE errors instead of filtering. A
  // second tab confirming the same day hits exactly that, and it is not a
  // failure: the day is already locked.
  if (error) {
    const current = await getDailyState(userId)
    if (current.list_confirmed) return current
    throw error
  }
  return (data as DailyState) ?? (await getDailyState(userId))
}

// --- tasks -----------------------------------------------------------------

export async function listTasks(userId: string): Promise<Task[]> {
  const db = requireClient()
  const { data, error } = await db
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('date', todayISO())
    .order('tier', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as Task[]
}

export async function addTasks(
  userId: string,
  titles: string[],
  afterConfirmation: boolean,
): Promise<void> {
  const db = requireClient()
  const rows = titles.map((title) => ({
    user_id: userId,
    date: todayISO(),
    title,
    tier: 2 as Tier, // you re-tier by hand on Task Review
    // claude_suggested_tier is deliberately left null. Weekend 1 has no Claude,
    // so writing a constant here would only pollute the "tier overrides vs
    // Claude" metric the weekly review reads in Weekend 2. Post-confirmation
    // re-tiering is prevented outright rather than logged.
    status: 'todo' as TaskStatus,
    created_after_confirmation: afterConfirmation,
  }))
  const { error } = await db.from('tasks').insert(rows)
  if (error) throw error
}

export async function updateTask(
  id: string,
  patch: Partial<Task>,
  afterConfirmation = false,
): Promise<void> {
  const db = requireClient()
  // Editing a title after the list is locked is allowed but flagged (spec 4.2).
  const full = afterConfirmation ? { ...patch, edited_after_confirmation: true } : patch
  // PostgREST answers 204 for an UPDATE that RLS filtered to zero rows, so the
  // returned rows are checked rather than the error — otherwise completeTask
  // could grant minutes for a task it never actually marked verified.
  const { data, error } = await db.from('tasks').update(full).eq('id', id).select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('That task could not be updated.')
}

/**
 * Only possible while the day's list is unconfirmed.
 *
 * PostgREST reports success with zero rows affected when RLS filters a DELETE,
 * so the returned rows are checked rather than the error.
 */
export async function deleteTask(id: string): Promise<void> {
  const db = requireClient()
  const { data, error } = await db.from('tasks').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error('That task can no longer be deleted — cancel it instead.')
  }
}

/**
 * Claim a task as verified, from a not-yet-verified state only.
 *
 * The `neq` is the guard against a double grant. completeTask credits after
 * verifying, and a credit whose response is lost throws *after* the row may
 * have committed — which used to leave the task rendered as todo with the
 * button live, so a second tap re-verified it and credited the minutes again.
 * A verify that has already happened now claims nothing, and the caller stops
 * before touching the balance.
 *
 * Returns false when the task was already verified by someone or something else.
 */
async function claimTaskVerified(id: string): Promise<boolean> {
  const db = requireClient()
  const { data, error } = await db
    .from('tasks')
    .update({ status: 'verified', verified_at: new Date().toISOString() })
    .eq('id', id)
    .neq('status', 'verified')
    .select('id')
  if (error) throw error
  return Boolean(data && data.length > 0)
}

/** Post-confirmation exit route: the task stays on the record as cancelled. */
export async function cancelTask(id: string): Promise<void> {
  await updateTask(id, { status: 'cancelled' })
}

// --- balances --------------------------------------------------------------

/** Today's balance row, or null when the day has none yet. */
async function readBalanceRow(userId: string): Promise<Balance | null> {
  const db = requireClient()
  const { data, error } = await db
    .from('balances')
    .select('*')
    .eq('user_id', userId)
    .eq('date', todayISO())
    .maybeSingle()
  if (error) throw error
  return (data as Balance) ?? null
}

export async function getBalance(userId: string): Promise<Balance> {
  const row = await readBalanceRow(userId)
  if (row) return row
  return {
    user_id: userId,
    date: todayISO(),
    minutes_available: 0,
    minutes_earned_total: 0,
    all_tasks_bonus: false,
  }
}

/**
 * Add `granted` minutes, but only if the balance still reads as `seen`.
 *
 * The filters carry the two counters this function writes, so PostgREST updates
 * nothing if either of them moved in between. Without that, this credit was a plain
 * read-modify-write and could overwrite a debit: complete a task in the app
 * while the block page is spending, and the write built on the pre-spend
 * numbers puts the spent minutes back while the session row keeps running —
 * minutes returned and the site unlocked, which is the free unlock the whole
 * schedule exists to prevent. The extension's debit has been a compare-and-swap
 * since it was written; this is the other half of the same balance.
 *
 * Returns false when the swap was refused, so the caller can re-read and retry.
 */
async function creditBalance(
  userId: string,
  seen: Balance | null,
  granted: number,
): Promise<boolean> {
  const db = requireClient()
  const date = todayISO()
  const next = {
    minutes_available: (seen?.minutes_available ?? 0) + granted,
    minutes_earned_total: (seen?.minutes_earned_total ?? 0) + granted,
    updated_at: new Date().toISOString(),
  }

  if (!seen) {
    // No row for today yet. A plain insert rather than an upsert, so that
    // losing the race to create it is a conflict to retry, not a blind
    // overwrite of whatever the winner wrote.
    const { error } = await db
      .from('balances')
      .insert({ user_id: userId, date, all_tasks_bonus: false, ...next })
    if (!error) return true
    if (error.code === '23505') return false
    throw error
  }

  const { data, error } = await db
    .from('balances')
    .update(next)
    .eq('user_id', userId)
    .eq('date', seen.date)
    .eq('minutes_available', seen.minutes_available)
    .eq('minutes_earned_total', seen.minutes_earned_total)
    .select('user_id')
  if (error) throw error
  return Boolean(data && data.length > 0)
}

async function writeBalance(balance: Balance): Promise<Balance> {
  const db = requireClient()
  const { data, error } = await db
    .from('balances')
    .upsert(
      {
        user_id: balance.user_id,
        date: balance.date,
        minutes_available: balance.minutes_available,
        minutes_earned_total: balance.minutes_earned_total,
        all_tasks_bonus: balance.all_tasks_bonus,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,date' },
    )
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Could not update your balance.')
  return data as Balance
}

/**
 * Mark a task done and deposit its minutes.
 *
 * Phase 1 is the honor system — proof capture and Claude verification are
 * Weekend 2, so "done" is a button. Earning is capped at DAILY_CAP_MINUTES,
 * and a task that earns nothing because the cap is hit still completes.
 * Returns the minutes actually granted.
 */
export async function completeTask(userId: string, task: Task): Promise<number> {
  // Verify first, credit second. If the credit then fails the task is done with
  // no minutes attached, which is the safe direction to fail: minutes granted
  // for a task that never got marked verified could be earned twice.
  //
  // The verify is a claim, not a write. Only the tap that moves the task out of
  // its unverified state goes on to credit, so a retry after a credit whose
  // answer was lost cannot pay for the same task twice.
  if (!(await claimTaskVerified(task.id))) {
    throw new Error(
      'That task is already marked done. Reload to see whether the minutes landed.',
    )
  }

  // Two passes, not a loop. A second refusal means something else is actively
  // writing this balance, and quietly winning that race is how a credit
  // overwrites a debit. The cap is recomputed on the retry rather than reused,
  // because the grant that beat us to it may have taken the remaining room.
  const seenAt: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen = await readBalanceRow(userId)
    seenAt.push(seen ? `${seen.minutes_available}/${seen.minutes_earned_total}` : 'none')
    // DAILY_CAP_MINUTES is mirrored by the balances_daily_cap CHECK constraint
    // in supabase/schema.sql. Tuning it (spec section 3 says to, after week 1)
    // means changing both, or the database will reject a grant this function
    // considers legitimate.
    const room = Math.max(0, DAILY_CAP_MINUTES - (seen?.minutes_earned_total ?? 0))
    const granted = Math.min(TIER_MINUTES[task.tier], room)
    if (granted === 0) return 0
    if (await creditBalance(userId, seen, granted)) return granted
  }

  // Two refusals with the balance reading the same both times is not a race —
  // nothing moved. The row is readable but will not take the write, which in
  // practice means RLS is filtering it. The extension's debit already draws
  // this distinction rather than blaming a race that did not happen; the credit
  // now does too.
  if (seenAt[0] === seenAt[1]) {
    throw new Error(
      'Your balance would not accept the minutes for that task. ' +
        'Check you are signed in as the same account, then reload.',
    )
  }
  throw new Error(
    'Your balance changed while that was saving, so the minutes were not added. ' +
      'Reload to see where it stands.',
  )
}

// --- sessions --------------------------------------------------------------

export async function getActiveSession(userId: string): Promise<AppSession | null> {
  const db = requireClient()
  // Deliberately not filtered by date: a session running across midnight is
  // dated yesterday, and filtering it out would strand it with ended_at null
  // forever, invisible to every code path.
  const { data, error } = await db
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as AppSession) ?? null
}

/**
 * Close out sessions left open on an earlier day.
 *
 * Minutes expire at midnight (spec section 3), so a session still running at
 * the rollover is over. Stamping ended_at logs it instead of leaving a row that
 * reads as permanently in progress — spec section 7 wants everything logged.
 */
export async function endStaleSessions(userId: string): Promise<void> {
  const db = requireClient()
  const { error } = await db
    .from('sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('ended_at', null)
    .lt('date', todayISO())
  if (error) throw error
}

/**
 * Start a session. **Deprecated as a user-facing action** (spec section 3A).
 *
 * Sessions are started at the block page now — the open IS the session start —
 * so nothing in the app calls this any more. It is kept because it is still the
 * canonical description of the write (deduct first, insert second), and because
 * the phone half of Phase 1 has no block page yet and will need it back.
 *
 * The two invariants it now enforces are the ones that make the schedule real:
 * outside the spend window there is no session to start at all, and an
 * always-allowed app is never metered.
 *
 * Minutes are spent up front, so a reload mid-session cannot buy them twice.
 *
 * @deprecated Sessions start from extension/blocked.js. See spec section 3A.
 */
export async function startSession(
  userId: string,
  appName: string,
  minutes: number,
): Promise<AppSession> {
  const db = requireClient()
  if (!canSpend()) throw new Error('Sessions can only be started in the spend window.')
  if (isAlwaysAllowed(appName)) throw new Error(`${appName} is always allowed and is never metered.`)
  const balance = await getBalance(userId)
  if (balance.minutes_available < minutes) throw new Error('Not enough minutes.')

  await writeBalance({ ...balance, minutes_available: balance.minutes_available - minutes })

  const { data, error } = await db
    .from('sessions')
    .insert({
      user_id: userId,
      date: todayISO(),
      app_name: appName,
      minutes,
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return data as AppSession
}

export async function endSession(id: string): Promise<void> {
  const db = requireClient()
  // Same zero-row trap as updateTask, and worse here: a silent no-op leaves the
  // session open, so the dashboard bounces straight back to it — an OK button
  // that appears to do nothing.
  const { data, error } = await db
    .from('sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('Could not close that session.')
}

export async function listSessions(userId: string): Promise<AppSession[]> {
  const db = requireClient()
  const { data, error } = await db
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('date', todayISO())
    .order('started_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as AppSession[]
}
