import { requireClient } from './supabase'
import { DAILY_CAP_MINUTES, TIER_MINUTES, type Tier } from './constants'
import { todayISO } from './date'

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
  const { error } = await db.from('tasks').update(full).eq('id', id)
  if (error) throw error
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

/** Post-confirmation exit route: the task stays on the record as cancelled. */
export async function cancelTask(id: string): Promise<void> {
  await updateTask(id, { status: 'cancelled' })
}

// --- balances --------------------------------------------------------------

export async function getBalance(userId: string): Promise<Balance> {
  const db = requireClient()
  const date = todayISO()
  const { data, error } = await db
    .from('balances')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle()
  if (error) throw error
  if (data) return data as Balance
  return {
    user_id: userId,
    date,
    minutes_available: 0,
    minutes_earned_total: 0,
    all_tasks_bonus: false,
  }
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
    .single()
  if (error) throw error
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
  const balance = await getBalance(userId)
  const room = Math.max(0, DAILY_CAP_MINUTES - balance.minutes_earned_total)
  const granted = Math.min(TIER_MINUTES[task.tier], room)

  await updateTask(task.id, { status: 'verified', verified_at: new Date().toISOString() })
  if (granted > 0) {
    await writeBalance({
      ...balance,
      minutes_available: balance.minutes_available + granted,
      minutes_earned_total: balance.minutes_earned_total + granted,
    })
  }
  return granted
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

/** Minutes are spent up front, so a reload mid-session cannot buy them twice. */
export async function startSession(
  userId: string,
  appName: string,
  minutes: number,
): Promise<AppSession> {
  const db = requireClient()
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
  const { error } = await db
    .from('sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
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
