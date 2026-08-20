/**
 * Today in the user's local timezone as YYYY-MM-DD.
 *
 * Every table is keyed by (user_id, date), so "today" is the whole of the
 * midnight reset for now: yesterday's tasks and balance simply stop being
 * queried. A scheduled function to archive them is Weekend 1 step 4.
 */
export function todayISO(): string {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
