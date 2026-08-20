import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, ErrorNote, Screen, Spinner } from '../components/ui'
import * as api from '../lib/api'
import { daysAgoKey, lastSevenDays, localDateKey, weekdayLabel } from '../lib/day'
import type { Balance, Session, Task, VerificationAttempt } from '../lib/types'

type Loaded = {
  tasks: Task[]
  sessions: Session[]
  balances: Balance[]
  attempts: VerificationAttempt[]
  cheats: api.CheatReport[]
}

export function WeeklyReview({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [observation, setObservation] = useState<{
    observation: string
    suggested_rule_change: string
  } | null>(null)
  const [thinking, setThinking] = useState(false)
  const [cheatCount, setCheatCount] = useState('')
  const [saved, setSaved] = useState(false)

  const from = daysAgoKey(6)
  const to = localDateKey()

  useEffect(() => {
    void (async () => {
      try {
        const [tasks, sessions, balances, attempts, cheats] = await Promise.all([
          api.getRange<Task>('tasks', userId, from, to),
          api.getRange<Session>('sessions', userId, from, to),
          api.getRange<Balance>('balances', userId, from, to),
          api.getRange<VerificationAttempt>('verification_attempts', userId, from, to),
          api.getCheatReports(userId, from, to),
        ])
        setData({ tasks, sessions, balances, attempts, cheats })
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [userId, from, to])

  const stats = useMemo(() => {
    if (!data) return null
    const { tasks, sessions, balances, attempts, cheats } = data
    const verified = tasks.filter((t) => t.status === 'verified')
    const overrides = tasks.filter(
      (t) => t.claude_suggested_tier !== null && t.claude_suggested_tier !== t.tier,
    )
    const downgrades = overrides.filter((t) => t.tier > (t.claude_suggested_tier ?? t.tier))
    const perApp = new Map<string, number>()
    for (const s of sessions) perApp.set(s.app_name, (perApp.get(s.app_name) ?? 0) + s.minutes)

    const earned = balances.reduce((n, b) => n + b.minutes_earned_total, 0)
    const spent = balances.reduce((n, b) => n + b.minutes_spent_total, 0)

    return {
      days: lastSevenDays().map((date) => {
        const dayTasks = tasks.filter((t) => t.date === date)
        return {
          date,
          label: weekdayLabel(date),
          total: dayTasks.length,
          verified: dayTasks.filter((t) => t.status === 'verified').length,
          bonus: balances.find((b) => b.date === date)?.all_tasks_bonus ?? false,
        }
      }),
      totalTasks: tasks.length,
      verifiedTasks: verified.length,
      completionRate: tasks.length ? Math.round((verified.length / tasks.length) * 100) : 0,
      minutesEarned: earned,
      minutesSpent: spent,
      minutesExpired: Math.max(earned - spent, 0),
      perApp: [...perApp.entries()].sort((a, b) => b[1] - a[1]),
      sessionCount: sessions.length,
      overrides: overrides.map((t) => ({
        title: t.title,
        claude: t.claude_suggested_tier,
        yours: t.tier,
      })),
      downgradeCount: downgrades.length,
      lateAdditions: tasks.filter((t) => t.created_after_confirmation).map((t) => t.title),
      rejections: attempts.filter((a) => a.verdict === 'REJECTED').length,
      followUps: attempts.filter((a) => a.verdict === 'FOLLOW_UP').length,
      spotChecks: attempts.filter((a) => a.forced_follow_up).length,
      manualCredits: attempts.filter((a) => a.verdict === 'MANUAL').length,
      selfReportedCheats: cheats.reduce((n, c) => n + c.count, 0),
    }
  }, [data])

  async function generate() {
    if (!stats) return
    setThinking(true)
    setError(null)
    try {
      setObservation(await api.weeklyObservation(stats))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setThinking(false)
    }
  }

  async function logCheats() {
    const n = Number(cheatCount)
    if (!Number.isFinite(n) || n < 0) return
    try {
      await api.saveCheatReport(userId, localDateKey(), Math.floor(n), null)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (error && !data) {
    return (
      <Screen>
        <div className="py-16">
          <ErrorNote>{error}</ErrorNote>
          <Button className="mt-4" onClick={() => navigate('/')}>
            Back
          </Button>
        </div>
      </Screen>
    )
  }

  if (!stats) {
    return (
      <Screen>
        <Spinner label="Adding up the week…" />
      </Screen>
    )
  }

  return (
    <Screen>
      <div className="flex flex-1 flex-col gap-5 py-8">
        <div>
          <p className="text-sm uppercase tracking-wide text-gray-500">Last 7 days</p>
          <h1 className="mt-1 text-2xl font-bold">Weekly review</h1>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Stat label="completed" value={`${stats.completionRate}%`} />
          <Stat label="min earned" value={stats.minutesEarned} />
          <Stat label="min spent" value={stats.minutesSpent} />
        </div>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-400">Day by day</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {stats.days.map((d) => (
              <li key={d.date} className="flex justify-between border-b border-gray-700 py-1">
                <span className="text-gray-400">{d.label}</span>
                <span className="tabular-nums">
                  {d.total === 0 ? (
                    <span className="text-gray-600">no list</span>
                  ) : (
                    <>
                      {d.verified}/{d.total} {d.bonus && '🔥'}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-400">Where the minutes went</h2>
          {stats.perApp.length === 0 ? (
            <p className="text-sm text-gray-500">No sessions this week.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {stats.perApp.map(([app, minutes]) => (
                <li key={app} className="flex justify-between">
                  <span>{app}</span>
                  <span className="tabular-nums text-gray-400">{minutes} min</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-500">
            {stats.minutesExpired} earned minutes expired unspent. {stats.sessionCount} sessions.
          </p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-400">The unflattering column</h2>
          <ul className="flex flex-col gap-1 text-sm text-gray-300">
            <li className="flex justify-between">
              <span>Tier overrides</span>
              <span className="tabular-nums">
                {stats.overrides.length} ({stats.downgradeCount} easier)
              </span>
            </li>
            <li className="flex justify-between">
              <span>Tasks added after confirming</span>
              <span className="tabular-nums">{stats.lateAdditions.length}</span>
            </li>
            <li className="flex justify-between">
              <span>Rejected proofs</span>
              <span className="tabular-nums">{stats.rejections}</span>
            </li>
            <li className="flex justify-between">
              <span>Follow-up questions (incl. {stats.spotChecks} spot checks)</span>
              <span className="tabular-nums">{stats.followUps}</span>
            </li>
            <li className="flex justify-between">
              <span>Credited without AI verification</span>
              <span className="tabular-nums">{stats.manualCredits}</span>
            </li>
            <li className="flex justify-between">
              <span>Self-reported opens with no session</span>
              <span className="tabular-nums">{stats.selfReportedCheats}</span>
            </li>
          </ul>

          {stats.overrides.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-xs text-amber-300">
              {stats.overrides.map((o, i) => (
                <li key={i}>
                  “{o.title}” — Claude said T{o.claude}, you filed it T{o.yours}
                </li>
              ))}
            </ul>
          )}
          {stats.lateAdditions.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-amber-300">
              {stats.lateAdditions.map((title, i) => (
                <li key={i}>“{title}” — added after the morning list was locked</li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-400">Cheat rate</h2>
          <p className="text-sm text-gray-400">
            How many times this week did you open one of these apps with no session running? Nobody
            checks this number but you, and it's the one that decides whether Phase 2 needs walls.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              inputMode="numeric"
              value={cheatCount}
              onChange={(e) => {
                setCheatCount(e.target.value)
                setSaved(false)
              }}
              placeholder="0"
              className="w-24 rounded border border-gray-600 bg-gray-900 px-3 py-2 text-base"
            />
            <Button variant="secondary" onClick={logCheats} disabled={cheatCount === ''}>
              {saved ? 'Logged' : 'Log it'}
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-gray-400">Claude's read</h2>
          {observation ? (
            <>
              <p className="whitespace-pre-wrap text-sm text-gray-200">{observation.observation}</p>
              <p className="mt-3 rounded border border-emerald-800 bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
                <span className="font-semibold">Try next week: </span>
                {observation.suggested_rule_change}
              </p>
            </>
          ) : (
            <Button variant="secondary" onClick={generate} disabled={thinking} className="w-full">
              {thinking ? 'Reading the week…' : 'Get an observation'}
            </Button>
          )}
        </Card>

        <ErrorNote>{error}</ErrorNote>

        <Button variant="ghost" className="mt-auto" onClick={() => navigate('/')}>
          Back to dashboard
        </Button>
      </div>
    </Screen>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-3 text-center">
      <p className="text-2xl font-bold tabular-nums text-emerald-400">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}
