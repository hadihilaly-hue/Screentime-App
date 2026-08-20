/**
 * Today in the user's local timezone as YYYY-MM-DD.
 *
 * Every table is keyed by (user_id, date), so this is the whole of the midnight
 * reset: when the date flips, yesterday's tasks and balance simply stop being
 * queried. Nothing is archived or deleted. useToday() watches for the flip in
 * an open tab.
 */
export function todayISO(): string {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
