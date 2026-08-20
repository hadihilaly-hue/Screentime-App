import { supabase } from './supabase'
import type {
  AppConfig,
  Balance,
  DailyState,
  DraftTask,
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
  if (data) return data as AppConfig

  // The signup trigger normally creates this row; this is the fallback for an
  // account that predates it.
  return unwrap(
    supabase.from('app_config').insert({ user_id: userId }).select().single(),
  ) as Promise<AppConfig>
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

export async function structureTasks(transcript: string): Promise<DraftTask[]> {
  const { data, error } = await supabase.functions.invoke('structure-tasks', {
    body: { transcript },
  })
  if (error) throw new Error(await readFunctionError(error, 'Could not structure that list.'))
  return (data.tasks as Omit<DraftTask, 'claude_suggested_tier'>[]).map((t) => ({
    ...t,
    claude_suggested_tier: t.tier,
  }))
}

export async function insertTasks(
  userId: string,
  date: string,
  drafts: DraftTask[],
  afterConfirmation: boolean,
  startPosition = 0,
): Promise<Task[]> {
  const rows = drafts.map((d, i) => ({
    user_id: userId,
    date,
    title: d.title.trim().slice(0, 200),
    tier: d.tier,
    claude_suggested_tier: d.claude_suggested_tier ?? null,
    proof_hint: d.proof_hint || null,
    self_report_only: d.self_report_only,
    created_after_confirmation: afterConfirmation,
    position: startPosition + i,
  }))
  return unwrap(supabase.from('tasks').insert(rows).select()) as Promise<Task[]>
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

export async function updateConfig(userId: string, patch: Partial<AppConfig>): Promise<void> {
  const { error } = await supabase.from('app_config').update(patch).eq('user_id', userId)
  if (error) throw new Error(error.message)
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
