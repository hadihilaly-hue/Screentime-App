import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from './lib/supabase'
import { endStaleSessions, getDailyState, type DailyState } from './lib/db'
import { useToday } from './lib/useToday'
import { Centered, Screen, Spinner } from './ui'

import MorningGate from './pages/MorningGate'
import TaskReview from './pages/TaskReview'
import Dashboard from './pages/Dashboard'
import ProofCapture from './pages/ProofCapture'
import VerificationResult from './pages/VerificationResult'
import ActiveSession from './pages/ActiveSession'
import WeeklyReview from './pages/WeeklyReview'
import Login from './pages/Login'

function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  return { session, loading }
}

/**
 * Routing is the morning gate (spec section 2 step 1): until today's list is
 * confirmed, every route redirects to it. There is no nav bar — you move
 * through the day in one direction.
 */
function SignedIn({ userId }: { userId: string }) {
  const [day, setDay] = useState<DailyState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    // A session left running across midnight is closed out first, so it is
    // logged rather than stranded with ended_at null (spec section 7).
    endStaleSessions(userId)
      .then(() => getDailyState(userId))
      .then(setDay)
      .catch((e: Error) => setError(e.message))
  }, [userId])

  useEffect(reload, [reload])

  if (error)
    return (
      <Centered>
        <p className="banner banner-error">{error}</p>
      </Centered>
    )
  if (!day) return <Spinner label="Loading today" />

  const confirmed = day.list_confirmed
  const gated = (element: ReactElement) =>
    confirmed ? element : <Navigate to="/" replace />

  return (
    <Routes>
      <Route
        path="/"
        element={confirmed ? <Navigate to="/dashboard" replace /> : <MorningGate userId={userId} />}
      />
      <Route path="/review" element={<TaskReview userId={userId} day={day} onConfirmed={setDay} />} />
      <Route path="/dashboard" element={gated(<Dashboard userId={userId} />)} />
      <Route path="/session" element={gated(<ActiveSession userId={userId} />)} />
      <Route path="/proof" element={gated(<ProofCapture />)} />
      <Route path="/verification" element={gated(<VerificationResult />)} />
      <Route path="/weekly" element={gated(<WeeklyReview />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function NotConfigured() {
  return (
    <Shell>
      <Screen
        eyebrow="Setup"
        title="Not connected"
        subtitle={
          <>
            Copy <code className="text-fg">.env.example</code> to{' '}
            <code className="text-fg">.env</code> and fill in{' '}
            <code className="text-fg">VITE_SUPABASE_URL</code> and{' '}
            <code className="text-fg">VITE_SUPABASE_ANON_KEY</code>, then restart the dev server.
            Nothing works without a database.
          </>
        }
      >
        <></>
      </Screen>
    </Shell>
  )
}

/** The phone-width column everything except the timer screen sits in. */
function Shell({ children }: { children: ReactElement }) {
  return (
    <div className="mx-auto w-full max-w-md px-5 safe-top safe-bottom">{children}</div>
  )
}

export default function App() {
  const { session, loading } = useSession()
  const today = useToday()

  // In production a missing config throws at import time in lib/supabase, so
  // this branch is dev-only by construction.
  if (!isSupabaseConfigured) return <NotConfigured />
  if (loading)
    return (
      <Shell>
        <Spinner />
      </Shell>
    )
  if (!session)
    return (
      <Shell>
        <Login />
      </Shell>
    )

  return (
    <BrowserRouter>
      <Shell>
        {/* Keyed on the date: at midnight this remounts, today's state is
            refetched, and the morning gate closes again for the new day. */}
        <SignedIn key={today} userId={session.user.id} />
      </Shell>
    </BrowserRouter>
  )
}
