import { useEffect, useState } from 'react'
import * as api from '../lib/api'
import { daysAgoKey, localDateKey } from '../lib/day'
import type { Balance } from '../lib/types'

/**
 * Consecutive days ending today (or yesterday, if today isn't finished yet) on
 * which every task got verified. Today only extends the streak once it's done —
 * an unfinished today never breaks it.
 */
export function useStreak(userId: string | null, version: unknown) {
  const [streak, setStreak] = useState(0)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const rows = await api.getRange<Balance>('balances', userId, daysAgoKey(60), localDateKey())
      const bonusDays = new Set(rows.filter((b) => b.all_tasks_bonus).map((b) => b.date))
      let count = 0
      let offset = bonusDays.has(localDateKey()) ? 0 : 1
      while (bonusDays.has(daysAgoKey(offset))) {
        count++
        offset++
      }
      if (!cancelled) setStreak(count)
    })().catch(() => setStreak(0))
    return () => {
      cancelled = true
    }
  }, [userId, version])

  return streak
}
