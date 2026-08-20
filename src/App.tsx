import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { useDay } from './hooks/useDay'
import { isConfigured } from './lib/supabase'
import { Auth } from './screens/Auth'
import { ActiveSession } from './screens/ActiveSession'
import { Dashboard } from './screens/Dashboard'
import { MorningGate } from './screens/MorningGate'
import { ProofCapture } from './screens/ProofCapture'
import { TaskReview } from './screens/TaskReview'
import { WeeklyReview } from './screens/WeeklyReview'
import { Card, ErrorNote, Screen, Spinner } from './components/ui'

export default function App() {
  const { user, loading: authLoading } = useAuth()
  const day = useDay(user?.id ?? null)

  if (!isConfigured) {
    return (
      <Screen>
        <div className="flex flex-1 items-center py-16">
          <Card>
            <h1 className="text-xl font-bold">Not wired up yet</h1>
            <p className="mt-2 text-sm text-gray-400">
              Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then
              reload. See README.md.
            </p>
          </Card>
        </div>
      </Screen>
    )
  }

  if (authLoading) return <Screen><Spinner /></Screen>
  if (!user) return <Auth />
  if (day.loading || !day.config) return <Screen><Spinner label="Loading today…" /></Screen>

  if (day.error) {
    return (
      <Screen>
        <div className="flex flex-1 items-center py-16">
          <ErrorNote>{day.error}</ErrorNote>
        </div>
      </Screen>
    )
  }

  // A running session takes over the whole screen. That is the point of it.
  if (day.activeSession) {
    return <ActiveSession session={day.activeSession} refresh={day.refresh} />
  }

  const confirmed = day.dailyState?.list_confirmed ?? false
  const stage: 'gate' | 'review' | 'open' = confirmed
    ? 'open'
    : day.tasks.length === 0
      ? 'gate'
      : 'review'

  const gate = (
    <MorningGate userId={user.id} date={day.date} onDone={day.refresh} />
  )
  const review = (
    <TaskReview
      userId={user.id}
      date={day.date}
      tasks={day.tasks}
      config={day.config}
      confirmed={confirmed}
      refresh={day.refresh}
    />
  )

  // Until the list is confirmed the only two reachable screens are the gate and
  // the review. Every other route bounces back.
  if (stage !== 'open') {
    return (
      <Routes>
        <Route path="/gate" element={gate} />
        <Route path="/review" element={review} />
        <Route path="*" element={<Navigate to={stage === 'gate' ? '/gate' : '/review'} replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <Dashboard
            userId={user.id}
            date={day.date}
            tasks={day.tasks}
            balance={day.balance}
            config={day.config}
            sessions={day.sessions}
            refresh={day.refresh}
          />
        }
      />
      <Route path="/gate" element={gate} />
      <Route path="/review" element={review} />
      <Route
        path="/task/:taskId"
        element={
          <ProofCapture
            userId={user.id}
            date={day.date}
            tasks={day.tasks}
            config={day.config}
            refresh={day.refresh}
          />
        }
      />
      <Route path="/weekly" element={<WeeklyReview userId={user.id} />} />
      <Route path="/session" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
