import { useEffect, useState } from 'react'
import { todayISO } from './date'

/**
 * Today's date, re-checked while the app is open.
 *
 * This is the midnight reset (spec section 8, Weekend 1 step 4) in its simpler
 * client-side form: every table is keyed by (user_id, date), so when the date
 * flips, today's rows simply become a fresh empty day. Without this, a tab left
 * open overnight keeps yesterday's confirmed state and walks straight past the
 * morning gate.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayISO)

  useEffect(() => {
    const check = () => setToday((prev) => (todayISO() === prev ? prev : todayISO()))
    const id = setInterval(check, 30_000)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [])

  return today
}
