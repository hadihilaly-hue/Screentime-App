import { Link } from 'react-router-dom'
import { StartSession } from '../components/StartSession'
import { Button, Card, Screen, StatusChip, TierBadge } from '../components/ui'
import { useStreak } from '../hooks/useStreak'
import * as api from '../lib/api'
import { isSunday } from '../lib/day'
import { supabase } from '../lib/supabase'
import type { AppConfig, Balance, Session, Task, Tier } from '../lib/types'

const TIER_LABEL: Record<Tier, string> = {
  1: 'Tier 1 — big and hard',
  2: 'Tier 2 — medium',
  3: 'Tier 3 — small',
}

export function Dashboard({
  userId,
  date,
  tasks,
  balance,
  config,
  sessions,
  refresh,
}: {
  userId: string
  date: string
  tasks: Task[]
  balance: Balance | null
  config: AppConfig
  sessions: Session[]
  refresh: () => Promise<void>
}) {
  const streak = useStreak(userId, balance?.all_tasks_bonus)
  const available = balance?.minutes_available ?? 0
  const unlimited = balance?.all_tasks_bonus ?? false
  const earned = balance?.minutes_earned_total ?? 0
  const done = tasks.filter((t) => t.status === 'verified').length
  const remainingCap = Math.max(config.daily_cap_minutes - earned, 0)

  const byTier: Array<[Tier, Task[]]> = ([1, 2, 3] as Tier[]).map((tier) => [
    tier,
    tasks.filter((t) => t.tier === tier),
  ])

  return (
    <Screen>
      <div className="flex flex-1 flex-col gap-5 py-8">
        <header className="flex items-start justify-between">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Balance</p>
            <p className="text-6xl font-bold tabular-nums text-emerald-400">
              {unlimited ? '∞' : available}
            </p>
            <p className="text-sm text-gray-400">
              {unlimited ? 'Everything done — unlimited until midnight' : 'minutes to spend'}
            </p>
          </div>
          <div className="text-right text-sm text-gray-400">
            <p>🔥 {streak} day streak</p>
            <p className="mt-1">
              {done}/{tasks.length} verified
            </p>
            <p className="mt-1 text-xs text-gray-500">{remainingCap} min left under the cap</p>
          </div>
        </header>

        {isSunday() && (
          <Link to="/weekly">
            <Card className="border-emerald-700">
              <p className="text-sm font-semibold text-emerald-300">It's Sunday.</p>
              <p className="mt-1 text-sm text-gray-300">
                Read the week back — completion, where the minutes went, and the parts you'd
                rather not look at.
              </p>
            </Card>
          </Link>
        )}

        <StartSession date={date} available={available} unlimited={unlimited} refresh={refresh} />

        <div className="flex flex-col gap-4">
          {byTier.map(([tier, list]) =>
            list.length === 0 ? null : (
              <section key={tier}>
                <div className="mb-2 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold text-gray-400">{TIER_LABEL[tier]}</h2>
                  <span className="text-xs text-gray-500">
                    {api.minutesForTier(config, tier)} min each
                  </span>
                </div>
                <ul className="flex flex-col gap-2">
                  {list.map((task) => (
                    <li key={task.id}>
                      <Link to={`/task/${task.id}`}>
                        <Card className="hover:border-gray-500">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1">
                              <p
                                className={`font-medium ${
                                  task.status === 'verified' ? 'text-gray-500 line-through' : ''
                                }`}
                              >
                                {task.title}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <StatusChip status={task.status} />
                                {task.status === 'verified' && (
                                  <span className="text-xs text-emerald-400">
                                    +{task.minutes_awarded} min
                                  </span>
                                )}
                                {task.created_after_confirmation && (
                                  <span className="text-xs text-amber-400">added late</span>
                                )}
                                {task.follow_up_question && task.status === 'pending' && (
                                  <span className="text-xs text-amber-300">question waiting</span>
                                )}
                              </div>
                            </div>
                            <TierBadge
                              tier={task.tier}
                              overridden={
                                task.claude_suggested_tier !== null &&
                                task.claude_suggested_tier !== task.tier
                              }
                            />
                          </div>
                        </Card>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>

        {sessions.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-400">Today's sessions</h2>
            <ul className="text-sm text-gray-400">
              {sessions.map((s) => (
                <li key={s.id} className="flex justify-between border-b border-gray-800 py-1">
                  <span>{s.app_name}</span>
                  <span className="tabular-nums">
                    {s.minutes}m {s.from_bonus ? '(bonus)' : ''}
                    {s.ended_at ? '' : ' · running'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-auto flex flex-col gap-2 pt-6">
          <Link to="/review">
            <Button variant="secondary" className="w-full">
              Edit today's list
            </Button>
          </Link>
          <Link to="/weekly">
            <Button variant="ghost" className="w-full">
              Weekly review
            </Button>
          </Link>
          <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </Screen>
  )
}
