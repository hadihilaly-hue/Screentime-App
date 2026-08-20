import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../lib/api'
import { localDateKey, msUntilMidnight } from '../lib/day'
import type { AppConfig, Balance, DailyState, Session, Task } from '../lib/types'

export type DayState = {
  date: string
  config: AppConfig | null
  dailyState: DailyState | null
  tasks: Task[]
  balance: Balance | null
  activeSession: Session | null
  sessions: Session[]
  loading: boolean
  error: string | null
}

const EMPTY: DayState = {
  date: localDateKey(),
  config: null,
  dailyState: null,
  tasks: [],
  balance: null,
  activeSession: null,
  sessions: [],
  loading: true,
  error: null,
}

/**
 * One place that knows what "today" is. It re-keys itself at local midnight, so
 * a phone left open overnight lands on tomorrow's empty morning gate rather
 * than yesterday's spent balance.
 */
export function useDay(userId: string | null) {
  const [state, setState] = useState<DayState>(EMPTY)
  const [date, setDate] = useState(localDateKey())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!userId) return
    const today = localDateKey()
    try {
      const [config, dailyState, tasks, balance, activeSession, sessions] = await Promise.all([
        api.getConfig(userId),
        api.getDailyState(userId, today),
        api.getTasks(userId, today),
        api.getBalance(userId, today),
        api.getActiveSession(userId),
        api.getRange<Session>('sessions', userId, today, today),
      ])
      if (!mounted.current) return
      setState({
        date: today,
        config,
        dailyState,
        tasks,
        balance,
        activeSession,
        sessions,
        loading: false,
        error: null,
      })
    } catch (err) {
      if (!mounted.current) return
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }))
    }
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setState({ ...EMPTY, loading: false })
      return
    }
    setState((s) => ({ ...s, loading: true }))
    void refresh()
  }, [userId, date, refresh])

  // Roll over at local midnight.
  useEffect(() => {
    const timer = setTimeout(() => setDate(localDateKey()), msUntilMidnight() + 1500)
    return () => clearTimeout(timer)
  }, [date])

  // A phone that was asleep may have missed the rollover timer entirely.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const today = localDateKey()
      if (today !== date) setDate(today)
      else void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [date, refresh])

  return { ...state, refresh }
}
