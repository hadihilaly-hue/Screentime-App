import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { getTask, type Task } from '../lib/db'
import {
  answerFollowup,
  claimVerifiedMinutes,
  isOffline,
  outcomeFromTask,
  type ProofOutcome,
} from '../lib/proof'
import { DAILY_CAP_MINUTES, TIER_MINUTES } from '../lib/constants'
import { IconCamera, IconCheck, IconClose, IconShield, Screen, Spinner } from '../ui'

/**
 * Spec section 4.5 — Verification Result.
 *
 * Four states, not three. Verified, rejected and follow-up are the spec's; the
 * fourth is "this did not happen", and it is the one this screen exists to keep
 * honest. A storage failure, a rate limit, an offline phone and Claude being
 * down each land here as themselves, saying plainly that nothing was decided —
 * never as a quiet pass and never as a rejection the photos did not earn.
 */
export default function VerificationResult() {
  const { taskId = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  // Arriving from a submission, the outcome rides along in router state. On a
  // reload it does not, so the task row is read and the outcome rebuilt.
  const passed = (location.state as { outcome?: ProofOutcome } | null)?.outcome ?? null

  const [outcome, setOutcome] = useState<ProofOutcome | null>(passed)
  const [task, setTask] = useState<Task | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getTask(taskId)
      .then((t) => {
        if (cancelled) return
        if (!t) {
          setLoadError('That task could not be found.')
          return
        }
        setTask(t)
        if (!passed) {
          const rebuilt = outcomeFromTask(t)
          if (rebuilt) setOutcome(rebuilt)
          else navigate(`/proof/${taskId}`, { replace: true })
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
    return () => {
      cancelled = true
    }
  }, [taskId, passed, navigate])

  async function sendAnswer(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const next = await answerFollowup(taskId, answer)
    setOutcome(next)
    setAnswer('')
    setBusy(false)
    setTask(await getTask(taskId).catch(() => task))
  }

  async function claim() {
    setBusy(true)
    setOutcome(await claimVerifiedMinutes(taskId))
    setBusy(false)
    setTask(await getTask(taskId).catch(() => task))
  }

  const toDashboard = (
    <button onClick={() => navigate('/dashboard')} className="press btn btn-secondary mt-3 w-full">
      Back to today
    </button>
  )

  if (loadError) {
    return (
      <Screen eyebrow="Verification" title="Not found">
        <p className="banner banner-error">{loadError}</p>
        {toDashboard}
      </Screen>
    )
  }
  if (!outcome) return <Spinner label="Reading the verdict" />

  const attemptsLine =
    'attemptsRemaining' in outcome && typeof outcome.attemptsRemaining === 'number' ? (
      <p className="mt-4 text-center text-[0.75rem] text-faint">
        {outcome.attemptsRemaining === 0
          ? 'No verification attempts left on this task today.'
          : `${outcome.attemptsRemaining} verification ${
              outcome.attemptsRemaining === 1 ? 'attempt' : 'attempts'
            } left on this task today.`}
      </p>
    ) : null

  // --- verified -------------------------------------------------------------
  if (outcome.kind === 'verified') {
    const worth = task ? TIER_MINUTES[task.tier] : null
    return (
      <Screen eyebrow="Verification">
        <div className="card flex flex-col items-center gap-4 px-6 py-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-acid text-ink">
            <IconCheck className="h-8 w-8" />
          </span>
          <h1 className="text-[1.75rem] leading-tight font-extrabold tracking-[-0.03em]">
            Verified
          </h1>
          {outcome.reason && (
            <p className="max-w-[26ch] text-[0.9375rem] leading-snug text-muted">{outcome.reason}</p>
          )}

          {outcome.creditError ? (
            // Verified is true and the minutes are not there. Both said out
            // loud, because showing either one alone is a lie by omission.
            <div className="w-full">
              <p className="banner banner-warn text-left">
                The task is verified, but the minutes were not added: {outcome.creditError}
              </p>
              <button onClick={claim} disabled={busy} className="press btn btn-primary mt-3 w-full">
                {busy ? 'Adding…' : 'Add the minutes'}
              </button>
            </div>
          ) : outcome.restored ? (
            <p className="text-[0.8125rem] text-faint">
              Recorded earlier. The dashboard has the balance.
            </p>
          ) : outcome.granted === 0 ? (
            <p className="banner banner-warn w-full text-left">
              Done — but you have hit the {DAILY_CAP_MINUTES} minute daily cap, so no minutes were
              added.
            </p>
          ) : (
            <>
              <p className="numeral text-6xl text-acid">+{outcome.granted}</p>
              <p className="text-[0.8125rem] font-semibold tracking-wide text-faint">
                MINUTES ADDED
              </p>
              {worth !== null && outcome.granted < worth && (
                <p className="banner banner-warn w-full text-left">
                  {outcome.granted} instead of {worth} — the daily cap is close.
                </p>
              )}
            </>
          )}
        </div>
        {toDashboard}
      </Screen>
    )
  }

  // --- rejected -------------------------------------------------------------
  if (outcome.kind === 'rejected') {
    return (
      <Screen eyebrow="Verification">
        <div className="card flex flex-col items-center gap-4 px-6 py-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-alert/15 text-alert">
            <IconClose className="h-8 w-8" />
          </span>
          <h1 className="text-[1.75rem] leading-tight font-extrabold tracking-[-0.03em]">
            Not verified
          </h1>
          <p className="max-w-[28ch] text-[0.9375rem] leading-snug text-muted">
            {outcome.reason || 'The photos did not match the task.'}
          </p>
          <p className="text-[0.8125rem] text-faint">
            No minutes were added. Take new photos and submit again.
          </p>
        </div>
        {attemptsLine}
        <button
          onClick={() => navigate(`/proof/${taskId}`)}
          className="press btn btn-primary mt-4 w-full"
        >
          <IconCamera />
          Take new photos
        </button>
        {toDashboard}
      </Screen>
    )
  }

  // --- follow-up ------------------------------------------------------------
  if (outcome.kind === 'needs_followup') {
    return (
      <Screen eyebrow="Verification" title="One question">
        <div className="card px-5 py-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-panel-hi text-muted">
            <IconShield className="h-6 w-6" />
          </span>
          <p className="mt-4 text-[1.0625rem] leading-snug font-semibold">{outcome.question}</p>
          {outcome.reason && (
            <p className="mt-2 text-[0.8125rem] leading-snug text-faint">{outcome.reason}</p>
          )}
        </div>

        <form onSubmit={sendAnswer} className="mt-4">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Answer in your own words"
            rows={3}
            autoFocus
            className="field resize-none"
          />
          <button
            type="submit"
            disabled={busy || !answer.trim() || isOffline()}
            className="press btn btn-primary mt-3 w-full"
          >
            {busy ? 'Sending…' : 'Send answer'}
          </button>
        </form>

        <p className="mt-3 text-[0.75rem] leading-snug text-faint">
          The answer goes back with the photos for a final verified or not-verified. It uses one of
          this task's verification attempts for today.
        </p>
        {attemptsLine}
        {toDashboard}
      </Screen>
    )
  }

  // --- nothing happened -----------------------------------------------------
  // The fourth state. Loud, named, and never confusable with a verdict.
  return (
    <Screen eyebrow="Verification" title="Nothing was decided">
      <p className="banner banner-error">{outcome.message}</p>
      <p className="mt-4 text-[0.8125rem] leading-snug text-faint">
        Your task is untouched — not verified, not rejected, and no minutes were added or removed.
        {outcome.code === 'rate_limited'
          ? ' The attempt limit is a cost guard on this project, not a judgement about the work.'
          : ''}
      </p>
      {outcome.retryable && outcome.code !== 'rate_limited' && (
        <button
          onClick={() => navigate(`/proof/${taskId}`)}
          className="press btn btn-primary mt-5 w-full"
        >
          <IconCamera />
          Try submitting again
        </button>
      )}
      {toDashboard}
    </Screen>
  )
}
