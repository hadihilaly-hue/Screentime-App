export type Tier = 1 | 2 | 3
export type TaskStatus = 'todo' | 'pending' | 'verified' | 'rejected'
export type Verdict = 'VERIFIED' | 'FOLLOW_UP' | 'REJECTED' | 'MANUAL'

export type AppConfig = {
  user_id: string
  tier1_minutes: number
  tier2_minutes: number
  tier3_minutes: number
  daily_cap_minutes: number
  follow_up_rate: number
}

export type DailyState = {
  user_id: string
  date: string
  list_confirmed: boolean
  confirmed_at: string | null
  raw_transcript: string | null
}

export type Task = {
  id: string
  user_id: string
  date: string
  title: string
  tier: Tier
  status: TaskStatus
  claude_suggested_tier: Tier | null
  proof_hint: string | null
  self_report_only: boolean
  proof_urls: string[]
  verification_notes: string | null
  follow_up_question: string | null
  follow_up_answer: string | null
  created_after_confirmation: boolean
  minutes_awarded: number
  position: number
  verified_at: string | null
  created_at: string
}

export type Balance = {
  user_id: string
  date: string
  minutes_available: number
  minutes_earned_total: number
  minutes_spent_total: number
  all_tasks_bonus: boolean
}

export type Session = {
  id: string
  user_id: string
  date: string
  app_name: string
  minutes: number
  from_bonus: boolean
  started_at: string
  ended_at: string | null
  acknowledged: boolean
}

export type VerificationAttempt = {
  id: string
  user_id: string
  task_id: string
  date: string
  verdict: Verdict
  reason: string | null
  follow_up_question: string | null
  follow_up_answer: string | null
  proof_urls: string[]
  forced_follow_up: boolean
  created_at: string
}

/** A task as Claude proposes it, before you have confirmed anything. */
export type DraftTask = {
  title: string
  tier: Tier
  proof_hint: string
  self_report_only: boolean
  /** null for a task you typed in yourself — there was no suggestion to override. */
  claude_suggested_tier: Tier | null
}

export type VerifyResponse = {
  verdict: 'VERIFIED' | 'FOLLOW_UP' | 'REJECTED'
  reason: string
  follow_up_question?: string
  credit?: {
    awarded: number
    full_value: number
    capped: boolean
    minutes_available: number
    minutes_earned_total: number
    all_tasks_bonus: boolean
  }
}

export const TRACKED_APPS = [
  'Snapchat',
  'Instagram',
  'YouTube',
  'Clash Royale',
  'Brawl Stars',
] as const

export const SESSION_LENGTHS = [5, 10, 15, 20] as const
