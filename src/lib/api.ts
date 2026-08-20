import { supabase } from './supabase'
import type {
  AppConfig,
  Balance,
  DailyState,
  Session,
  Task,
  Tier,
  VerificationAttempt,
  VerifyResponse,
} from './types'

async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data as T
}

// --- reads -----------------------------------------------------------------

export async function getConfig(userId: string): Promise<AppConfig> {
  const { data, error } = await supabase
    .from('app_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)

  if (data) return syncTimezone(data as AppConfig)

  // The signup trigger normally creates this row; this is the fallback for an
  // account that predates it.
  const created = (await unwrap(
    supabase.from('app_config').insert({ user_id: userId }).select().single(),
  )) as AppConfig
  return syncTimezone(created)
}

/**
 * The server derives "today" from the stored timezone, so it has to track the
 * device you actually carry — but it is not a column the browser may write. The
 * RPC validates, logs the change, and returns the zone actually in effect: if
 * the server's tzdata doesn't know the name (browsers can be newer), the old
 * one stands and `timezoneMismatch` below goes true rather than the app
 * pretending the write landed.
 */
async function syncTimezone(config: AppConfig): Promise<AppConfig> {
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!deviceZone || deviceZone === config.timezone) return config

  const { data, error } = await supabase.rpc('set_timezone', { p_timezone: deviceZone })
  if (error) throw new Error(error.message)
  return { ...config, timezone: (data as string) ?? config.timezone }
}

/** True when the server could not adopt this device's timezone. Everything
 *  date-keyed will fail while this is true, so it needs to be visible. */
export function timezoneMismatch(config: AppConfig): string | null {
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return deviceZone && deviceZone !== config.timezone ? deviceZone : null
}

export async function getDailyState(userId: string, date: string): Promise<DailyState | null> {
  const { data, error } = await supabase
    .from('daily_state')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as DailyState | null
}

export async function getTasks(userId: string, date: string): Promise<Task[]> {
  return unwrap(
    supabase
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('date', date)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true }),
  ) as Promise<Task[]>
}

export async function getBalance(userId: string, date: string): Promise<Balance | null> {
  const { data, error } = await supabase
    .from('balances')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as Balance | null
}

export async function getActiveSession(userId: string): Promise<Session | null> {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as Session | null
}

export async function getRange<T>(
  table: 'tasks' | 'sessions' | 'balances' | 'verification_attempts' | 'daily_state',
  userId: string,
  from: string,
  to: string,
): Promise<T[]> {
  return unwrap(
    supabase.from(table).select('*').eq('user_id', userId).gte('date', from).lte('date', to),
  ) as Promise<T[]>
}

// --- morning gate ----------------------------------------------------------

/**
 * Creates today's tasks from the raw ramble and returns them. The Edge Function
 * does the insert with the service role — `claude_suggested_tier` is the entire
 * basis of the override log, so the browser is never the one to write it.
 */
export async function structureTasks(transcript: string, date: string): Promise<Task[]> {
  const { data, error } = await supabase.functions.invoke('structure-tasks', {
    body: { transcript, date },
  })
  if (error) throw new Error(await readFunctionError(error, 'Could not structure that list.'))
  return data.tasks as Task[]
}

/**
 * Adds a task you typed yourself. Only title, tier and position are sent —
 * `created_after_confirmation` is derived from daily_state by a trigger, and
 * `claude_suggested_tier` is forced to null, because a tier you picked has no
 * suggestion to override. The client does not get to author its own alibi.
 */
export async function addOwnTask(
  userId: string,
  date: string,
  title: string,
  tier: Tier,
  position: number,
): Promise<Task[]> {
  return unwrap(
    supabase
      .from('tasks')
      .insert([{ user_id: userId, date, title: title.trim().slice(0, 200), tier, position }])
      .select(),
  ) as Promise<Task[]>
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  const { error } = await supabase.from('tasks').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function reorderTasks(tasks: Task[]): Promise<void> {
  await Promise.all(tasks.map((t, i) => updateTask(t.id, { position: i, tier: t.tier })))
}

export async function confirmDay(date: string, transcript: string | null): Promise<DailyState> {
  return unwrap(
    supabase.rpc('confirm_day', { p_date: date, p_transcript: transcript }).select().single(),
  ) as Promise<DailyState>
}

// --- proof -----------------------------------------------------------------

export type CapturedPhoto = { blob: Blob; capturedAt: number; previewUrl: string }

export async function uploadProof(
  userId: string,
  date: string,
  taskId: string,
  photo: CapturedPhoto,
): Promise<string> {
  const path = `${userId}/${date}/${taskId}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage
    .from('proofs')
    .upload(path, photo.blob, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error(error.message)
  return path
}

export async function verifyProof(args: {
  taskId: string
  proofPaths: string[]
  capturedAt: number
}): Promise<VerifyResponse> {
  const { data, error } = await supabase.functions.invoke('verify-proof', {
    body: {
      task_id: args.taskId,
      mode: 'photo',
      proof_paths: args.proofPaths,
      captured_at: new Date(args.capturedAt).toISOString(),
    },
  })
  if (error) throw new Error(await readFunctionError(error, 'Verification failed.'))
  return data as VerifyResponse
}

export async function answerFollowUp(taskId: string, answer: string): Promise<VerifyResponse> {
  const { data, error } = await supabase.functions.invoke('verify-proof', {
    body: { task_id: taskId, mode: 'follow_up', follow_up_answer: answer },
  })
  if (error) throw new Error(await readFunctionError(error, 'Could not submit that answer.'))
  return data as VerifyResponse
}

export async function selfReport(taskId: string): Promise<VerifyResponse> {
  const { data, error } = await supabase.functions.invoke('verify-proof', {
    body: { task_id: taskId, mode: 'self_report' },
  })
  if (error) throw new Error(await readFunctionError(error, 'Could not log that.'))
  return data as VerifyResponse
}

/** No-AI fallback (Weekend 1, or Edge Functions not deployed yet). Logged as
 *  MANUAL so it stands out in the weekly review. */
export async function creditManually(taskId: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('credit_manual_task', {
    p_task_id: taskId,
    p_note: note ?? null,
  })
  if (error) throw new Error(error.message)
}

export async function signedProofUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('proofs').createSignedUrl(path, 300)
  return data?.signedUrl ?? null
}

// --- sessions --------------------------------------------------------------

export async function startSession(
  date: string,
  appName: string,
  minutes: number,
): Promise<Session> {
  const { data, error } = await supabase.rpc('start_session', {
    p_date: date,
    p_app_name: appName,
    p_minutes: minutes,
  })
  if (error) throw new Error(error.message)
  return data as Session
}

export async function endSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('end_session', { p_session_id: sessionId })
  if (error) throw new Error(error.message)
}

// --- weekly ----------------------------------------------------------------

export async function weeklyObservation(
  stats: unknown,
): Promise<{ observation: string; suggested_rule_change: string }> {
  const { data, error } = await supabase.functions.invoke('weekly-observation', {
    body: { stats },
  })
  if (error) throw new Error(await readFunctionError(error, 'No observation available.'))
  return data
}

export function minutesForTier(config: AppConfig, tier: Tier): number {
  return tier === 1 ? config.tier1_minutes : tier === 2 ? config.tier2_minutes : config.tier3_minutes
}

export type { VerificationAttempt }

/**
 * supabase-js wraps a non-2xx Edge Function response in a FunctionsHttpError
 * whose useful text is only on `.context`. Without this every failure reads
 * "Edge Function returned a non-2xx status code", which tells you nothing.
 */
async function readFunctionError(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.clone().json()
      if (body?.error) return String(body.error)
    } catch {
      /* not JSON — fall through */
    }
  }
  const message = (error as { message?: string }).message
  return message && !/non-2xx/i.test(message) ? message : fallback
}

// --- honesty log -----------------------------------------------------------

export type CheatReport = {
  user_id: string
  date: string
  count: number
  note: string | null
}

export async function getTimezoneChanges(
  userId: string,
  from: string,
  to: string,
): Promise<Array<{ from_zone: string; to_zone: string; created_at: string }>> {
  return unwrap(
    supabase
      .from('timezone_changes')
      .select('from_zone, to_zone, created_at')
      .eq('user_id', userId)
      .gte('created_at', `${from}T00:00:00Z`)
      .lte('created_at', `${to}T23:59:59Z`),
  ) as Promise<Array<{ from_zone: string; to_zone: string; created_at: string }>>
}

export async function getCheatReports(
  userId: string,
  from: string,
  to: string,
): Promise<CheatReport[]> {
  return unwrap(
    supabase
      .from('cheat_reports')
      .select('*')
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to),
  ) as Promise<CheatReport[]>
}

export async function saveCheatReport(
  userId: string,
  date: string,
  count: number,
  note: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('cheat_reports')
    .upsert({ user_id: userId, date, count, note }, { onConflict: 'user_id,date' })
  if (error) throw new Error(error.message)
}
