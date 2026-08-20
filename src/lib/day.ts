/**
 * Everything in this app is keyed to the *device-local* calendar day. That is
 * the whole midnight reset: at 00:00 the key changes, so today's balance row,
 * task list and confirmation simply do not exist yet. No scheduled function,
 * nothing to go wrong at 3am.
 */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysAgoKey(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDateKey(d)
}

/** The last 7 local days, oldest first, ending today. */
export function lastSevenDays(): string[] {
  return [6, 5, 4, 3, 2, 1, 0].map(daysAgoKey)
}

export function msUntilMidnight(): number {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return midnight.getTime() - now.getTime()
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${String(rem).padStart(2, '0')}`
}

export function weekdayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' })
}

export function isSunday(): boolean {
  return new Date().getDay() === 0
}
