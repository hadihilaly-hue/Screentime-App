import { useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from './lib/supabase'

import MorningGate from './pages/MorningGate'
import TaskReview from './pages/TaskReview'
import Dashboard from './pages/Dashboard'
import ProofCapture from './pages/ProofCapture'
import VerificationResult from './pages/VerificationResult'
import ActiveSession from './pages/ActiveSession'
import WeeklyReview from './pages/WeeklyReview'
import Login from './pages/Login'

const NAV = [
  { to: '/', label: 'Gate' },
  { to: '/review', label: 'Review' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/proof', label: 'Proof' },
  { to: '/verification', label: 'Verification' },
  { to: '/session', label: 'Session' },
  { to: '/weekly', label: 'Weekly' },
]

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

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()

  // Without .env values there is no auth to check. Browse the shell, but say so.
  if (!isSupabaseConfigured) return <>{children}</>
  if (loading) return <p>Loading...</p>
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl p-4">
      {!isSupabaseConfigured && (
        <p className="mb-4 border border-red-500 bg-red-50 p-2 text-sm text-red-700">
          Not connected to Supabase — auth is not enforced. Set VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY in .env.
        </p>
      )}
      <nav className="mb-4 flex flex-wrap gap-3 border-b pb-2 text-sm">
        {NAV.map((item) => (
          <Link key={item.to} to={item.to} className="underline">
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><MorningGate /></RequireAuth>} />
          <Route path="/review" element={<RequireAuth><TaskReview /></RequireAuth>} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/proof" element={<RequireAuth><ProofCapture /></RequireAuth>} />
          <Route path="/verification" element={<RequireAuth><VerificationResult /></RequireAuth>} />
          <Route path="/session" element={<RequireAuth><ActiveSession /></RequireAuth>} />
          <Route path="/weekly" element={<RequireAuth><WeeklyReview /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
