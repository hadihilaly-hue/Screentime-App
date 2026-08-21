import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getActiveSession,
  getBalance,
  listTasks,
  type Balance,
  type Task,
} from '../lib/db'
import {
  DAILY_CAP_MINUTES,
  SESSION_LENGTHS,
  TIER_LABELS,
  TIER_MINUTES,
  type Tier,
} from '../lib/constants'
import { clockLabel, phaseAt, spendOpensAt, untilLabel } from '../lib/schedule'
import { IconCheck, Spinner } from '../ui'

const STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'todo',
  pending: 'pending proof',
  verified: 'verified',
  rejected: 'rejected',
  cancelled: 'cancelled',
}

/**
 * What a task's chip says.
 *
 * status and verification_verdict are separate columns on purpose (the verdict
 * is server-written; status is claimed by the credit's compare-and-swap), and
 * until the credit lands a task Claude rejected is still status 'todo'. Reading
 * the verdict first is what stops the list saying "todo" about a task that has
 * a question waiting on it.
 */
function statusLabel(task: Task): string {
  if (task.status === 'verified' || task.status === 'cancelled') return STATUS_LABEL[task.status]
  if (task.verification_verdict === 'needs_followup') return 'one question waiting'
  if (task.verification_verdict === 'rejected') return 'not verified — retake'
  if (task.verification_verdict === 'verified') return 'verified — minutes not added'
  return STATUS_LABEL[task.status]
}

/** Spec section 4 screen 3. */
export default function Dashboard({ userId }: { userId: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [balance, setBalance] = useState<Balance | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  /**
   * Which reload is allowed to write to state.
   *
   * A poll already awaiting getBalance when this screen navigates away resolves
   * afterwards and writes into a screen on its way out. Every reload takes a
   * ticket and drops its results if a newer one has been issued since. This
   * mattered more when the dashboard credited tasks itself; it still matters,
   * because the poll and the navigation to proof capture can overlap.
   */
  const reloadSeq = useRef(0)
  /**
   * Where the banner on screen came from.
   *
   * 'poll' clears when a poll succeeds; 'action' persists until the next action
   * and is never overwritten by a poll — a poll runs every ten seconds, and
   * losing the reason something refused under a transient network blip is worse
   * than showing nothing about the blip.
   */
  const errorSource = useRef<'poll' | 'action' | null>(null)
  const navigate = useNavigate()

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current
    const stale = () => seq !== reloadSeq.current
    try {
      const active = await getActiveSession(userId)
      if (stale()) return
      if (active) {
        // Claim the sequence before navigating, so a reload still in flight
        // cannot write into a screen that is on its way out.
        reloadSeq.current++
        navigate('/session')
        return
      }
      const nextTasks = await listTasks(userId)
      const nextBalance = await getBalance(userId)
      if (stale()) return
      setTasks(nextTasks)
      setBalance(nextBalance)
      // Clear only a banner a previous poll put up.
      if (errorSource.current === 'poll') {
        errorSource.current = null
        setError(null)
      }
    } catch (e) {
      if (stale()) return
      // Never paper over an action's failure with a poll's.
      if (errorSource.current === 'action') return
      errorSource.current = 'poll'
      setError((e as Error).message)
    }
  }, [userId, navigate])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * The clock ticks and the data is re-read on the same beat.
   *
   * The clock, because the window is derived from it: at 6:00pm this screen has
   * to stop saying "spendable at 6:00 PM" without anyone reloading it.
   *
   * The data, because sessions now start at the block page (spec section 3A) —
   * a spend happens somewhere this screen cannot see. Without the re-read the
   * dashboard sat on the pre-spend balance with no countdown until a manual
   * reload; reload() navigates to /session when it finds one, so the timer
   * appears here on its own. Coming back to the tab checks immediately rather
   * than waiting out the interval.
   */
  useEffect(() => {
    const tick = () => {
      setNow(Date.now())
      void reload()
    }
    const id = setInterval(tick, 10_000)
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [reload])

  /**
   * Tapping the check no longer completes anything.
   *
   * Since proof capture landed, the only route from todo to verified runs
   * through photos and the verify-proof Edge Function (spec section 2 step 4).
   * This screen's job is to hand the task over; the credit still happens in
   * completeTask, called from lib/proof once a verdict comes back verified.
   */
  function openProof(task: Task) {
    // Invalidate any reload in flight so it cannot write into a screen that is
    // on its way out.
    reloadSeq.current++
    // Two verdicts already have an answer waiting and must not be sent back to
    // the camera. A pending question is answered with a sentence. A verdict of
    // verified whose credit did not land needs the credit retried, not new
    // photos — re-photographing it would spend one of the day's three attempts
    // and could replace a verdict of verified with a rejection, which is a
    // spectacularly bad trade for a task Claude has already passed.
    if (
      task.verification_verdict === 'needs_followup' ||
      task.verification_verdict === 'verified'
    ) {
      navigate(`/verification/${task.id}`)
      return
    }
    navigate(`/proof/${task.id}`)
  }

  if (!balance) return <Spinner />

  const open = tasks.filter((t) => t.status === 'todo')
  const capPct = Math.min(100, (balance.minutes_earned_total / DAILY_CAP_MINUTES) * 100)
  const phase = phaseAt(now)
  // "Spendable" is the balance *and* the window, per spec section 3A. Before
  // 6pm a growing number that buys nothing has to say so, or it reads as a bug.
  const spendableNow = phase.kind === 'spend' && balance.minutes_available > 0
  const opensAt = spendOpensAt(now)

  return (
    <section className="fade-up">
      {/* --- balance ------------------------------------------------------
          The one number the whole app exists to move. */}
      <div className="pt-2 pb-7">
        <p className="eyebrow">Balance</p>
        <div className="mt-2 flex items-end gap-3">
          <span
            className={`numeral text-[5.5rem] ${spendableNow ? 'text-acid' : 'text-fg'}`}
          >
            {balance.minutes_available}
          </span>
          <span className="pb-3 text-[0.9375rem] leading-tight font-semibold text-muted">
            {phase.kind === 'spend' ? (
              <>
                minutes
                <br />
                available
              </>
            ) : (
              <>
                minutes
                <br />
                <span className="text-ember">spendable at {clockLabel(opensAt)}</span>
              </>
            )}
          </span>
        </div>

        {phase.kind !== 'spend' && (
          <p className="mt-3 text-[0.8125rem] leading-snug text-faint">
            {phase.kind === 'open'
              ? `Open window — nothing is blocked until ${clockLabel(phase.endsAt)}. The spend window is ${clockLabel(opensAt)} to midnight.`
              : `Locked until ${clockLabel(phase.endsAt)}. Minutes you earn now are waiting for you — spending opens in ${untilLabel(opensAt, now)}.`}
          </p>
        )}

        <div className="mt-5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-hi">
            <div
              className="h-full rounded-full bg-acid transition-[width] duration-500 ease-out"
              style={{ width: `${capPct}%` }}
            />
          </div>
          <p className="mt-2 text-[0.8125rem] font-medium text-faint">
            Earned today {balance.minutes_earned_total} / {DAILY_CAP_MINUTES}
          </p>
        </div>
      </div>

      {error && <p className="banner banner-error mb-4">{error}</p>}

      {/* --- tasks --------------------------------------------------------- */}
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold tracking-[-0.02em]">Today's tasks</h2>
        <button onClick={() => navigate('/review')} className="press text-sm font-semibold text-muted">
          Edit list
        </button>
      </div>

      {/* Grouped by tier, per spec section 2 step 3. */}
      {([1, 2, 3] as Tier[]).map((tier) => {
        const inTier = tasks.filter((t) => t.tier === tier)
        if (inTier.length === 0) return null
        return (
          <div key={tier} className="mt-5">
            <h3 className="eyebrow">{TIER_LABELS[tier]}</h3>
            <ul className="mt-2.5 flex flex-col gap-2">
              {inTier.map((task) => {
                const done = task.status === 'verified' || task.status === 'cancelled'
                return (
                  <li
                    key={task.id}
                    className={`card flex items-center gap-3 px-4 py-3.5 ${done ? 'opacity-55' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-[0.9375rem] font-semibold leading-snug ${
                          done ? 'line-through decoration-faint' : ''
                        }`}
                      >
                        {task.title}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[0.75rem] font-bold text-acid">
                          {TIER_MINUTES[task.tier]}m
                        </span>
                        <span className="text-[0.75rem] text-faint">
                          · {statusLabel(task)}
                        </span>
                        {task.created_after_confirmation && (
                          <span className="tag tag-warn">added late</span>
                        )}
                        {task.edited_after_confirmation && (
                          <span className="tag tag-warn">edited late</span>
                        )}
                      </div>
                    </div>
                    {task.status === 'todo' && (
                      <button
                        aria-label={`Submit proof for "${task.title}"`}
                        onClick={() => openProof(task)}
                        className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-faint disabled:opacity-40 active:border-acid active:bg-acid active:text-ink"
                      >
                        <IconCheck />
                      </button>
                    )}
                    {task.status === 'verified' && (
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-acid/15 text-acid">
                        <IconCheck />
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}

      {open.length === 0 && tasks.length > 0 && (
        <p className="mt-4 text-[0.8125rem] text-faint">
          Nothing open. Full-completion bonus lands in Weekend 2.
        </p>
      )}

      {/* --- spend ---------------------------------------------------------
          Read-only since spec section 3A: the open IS the session start, so
          this panel explains where and when, and starts nothing. The lengths
          are shown because knowing what a session costs is what makes the
          balance mean anything before you are standing at the door. */}
      <div className="mt-9">
        <h2 className="text-lg font-bold tracking-[-0.02em]">Spending</h2>

        <div className="card mt-3 px-4 py-4">
          <p className="text-[0.9375rem] leading-snug font-semibold">
            {phase.kind === 'spend'
              ? `Open a tracked site. Pick a length there — the window closes at ${clockLabel(phase.endsAt)}.`
              : `Locked until ${clockLabel(opensAt)}.`}
          </p>
          <p className="mt-1.5 text-[0.8125rem] leading-snug text-muted">
            {phase.kind === 'spend'
              ? 'The block page is where sessions start now. Choosing at the door, with the balance in front of you, is the same decision with the cost attached.'
              : 'Earning works at every hour — finish a task now and the minutes are there when the window opens.'}
          </p>

          <div className="mt-3.5 flex gap-2">
            {SESSION_LENGTHS.map((minutes) => (
              <span
                key={minutes}
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl border border-line py-3 ${
                  phase.kind === 'spend' && balance.minutes_available >= minutes
                    ? 'text-fg'
                    : 'text-faint opacity-45'
                }`}
              >
                <span className="numeral text-xl">{minutes}</span>
                <span className="text-[0.625rem] font-semibold tracking-wide text-faint">MIN</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
