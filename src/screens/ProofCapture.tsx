import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CameraCapture } from '../components/CameraCapture'
import { Button, Card, ErrorNote, Screen, TierBadge } from '../components/ui'
import * as api from '../lib/api'
import type { CapturedPhoto } from '../lib/api'
import type { AppConfig, Task, VerifyResponse } from '../lib/types'

const MAX_PHOTOS = 3
/** Matches the server guard in verify-proof. */
const CAPTURE_WINDOW_MS = 2 * 60 * 1000

export function ProofCapture({
  userId,
  date,
  tasks,
  config,
  refresh,
}: {
  userId: string
  date: string
  tasks: Task[]
  config: AppConfig
  refresh: () => Promise<void>
}) {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const task = tasks.find((t) => t.id === taskId)

  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiDown, setAiDown] = useState(false)
  const [result, setResult] = useState<VerifyResponse | null>(null)
  const [answer, setAnswer] = useState('')

  if (!task) {
    return (
      <Screen>
        <div className="py-16">
          <p className="text-gray-400">That task isn't on today's list.</p>
          <Button className="mt-4" onClick={() => navigate('/')}>
            Back
          </Button>
        </div>
      </Screen>
    )
  }

  const openQuestion =
    result?.follow_up_question ??
    (result ? null : task.status === 'pending' ? task.follow_up_question : null)
  const worth = api.minutesForTier(config, task.tier)
  const alreadyDone = task.status === 'verified' && !result

  async function submit() {
    if (!task) return
    setBusy(true)
    setError(null)
    try {
      const capturedAt = Math.min(...photos.map((p) => p.capturedAt))
      if (Date.now() - capturedAt > CAPTURE_WINDOW_MS) {
        throw new Error('Those photos are stale. Take a fresh one — the window is 2 minutes.')
      }
      const paths = await Promise.all(
        photos.map((photo) => api.uploadProof(userId, date, task.id, photo)),
      )
      const verdict = await api.verifyProof({ taskId: task.id, proofPaths: paths, capturedAt })
      setResult(verdict)
      setPhotos([])
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setAiDown(/down|non-2xx|failed to fetch|502/i.test((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  async function sendAnswer() {
    if (!task) return
    setBusy(true)
    setError(null)
    try {
      const verdict = await api.answerFollowUp(task.id, answer)
      setResult(verdict)
      setAnswer('')
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function markSelfReported() {
    if (!task) return
    setBusy(true)
    setError(null)
    try {
      const verdict = await api.selfReport(task.id)
      setResult(verdict)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setAiDown(true)
    } finally {
      setBusy(false)
    }
  }

  async function creditManually() {
    if (!task) return
    setBusy(true)
    setError(null)
    try {
      await api.creditManually(task.id, 'Credited without AI verification.')
      await refresh()
      navigate('/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // --- verdict screens ------------------------------------------------------
  if (alreadyDone) {
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
          <p className="text-6xl">✅</p>
          <h1 className="text-2xl font-bold text-emerald-400">Already banked</h1>
          <p className="text-gray-300">
            “{task.title}” earned {task.minutes_awarded} min.
          </p>
          {task.verification_notes && (
            <p className="text-sm text-gray-500">{task.verification_notes}</p>
          )}
          <Button onClick={() => navigate('/')}>Back to dashboard</Button>
        </div>
      </Screen>
    )
  }

  if (result?.verdict === 'VERIFIED') {
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
          <p className="text-6xl">✅</p>
          <h1 className="text-3xl font-bold text-emerald-400">
            +{result.credit?.awarded ?? worth} minutes
          </h1>
          <p className="text-gray-300">{result.reason}</p>
          {result.credit?.capped && (
            <p className="text-sm text-amber-300">
              Trimmed to the {config.daily_cap_minutes} min daily cap — the task was worth{' '}
              {result.credit.full_value}.
            </p>
          )}
          {result.credit?.all_tasks_bonus && (
            <p className="text-lg font-semibold text-emerald-300">
              Everything on today's list is done. Unlimited until midnight.
            </p>
          )}
          <Button onClick={() => navigate('/')}>Back to dashboard</Button>
        </div>
      </Screen>
    )
  }

  if (openQuestion) {
    return (
      <Screen>
        <div className="flex flex-1 flex-col gap-4 py-10">
          <p className="text-sm uppercase tracking-wide text-gray-500">One question</p>
          <h1 className="text-2xl font-bold">{openQuestion}</h1>
          <p className="text-sm text-gray-400">
            Answerable only by someone who actually did it. One shot — the answer decides the
            verdict.
          </p>
          <textarea
            rows={4}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-3 text-base"
          />
          <ErrorNote>{error}</ErrorNote>
          <Button onClick={sendAnswer} disabled={busy || answer.trim().length < 1}>
            {busy ? 'Sending…' : 'Answer'}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            Later
          </Button>
        </div>
      </Screen>
    )
  }

  if (result?.verdict === 'REJECTED') {
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
          <p className="text-6xl">🚫</p>
          <h1 className="text-2xl font-bold text-red-400">Rejected</h1>
          <p className="text-gray-300">{result.reason}</p>
          <p className="text-xs text-gray-500">
            This rejection stays in the record and shows up in Sunday's review.
          </p>
          <Button onClick={() => setResult(null)}>Retake</Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            Back to dashboard
          </Button>
        </div>
      </Screen>
    )
  }

  // --- capture ---------------------------------------------------------------
  return (
    <Screen>
      <div className="flex flex-1 flex-col gap-4 py-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Prove it</p>
            <h1 className="mt-1 text-2xl font-bold">{task.title}</h1>
            <p className="mt-1 text-sm text-emerald-400">Worth {worth} min</p>
          </div>
          <TierBadge tier={task.tier} />
        </div>

        {task.proof_hint && (
          <Card>
            <p className="text-sm text-gray-300">
              <span className="text-gray-500">What a passing photo shows: </span>
              {task.proof_hint}
            </p>
          </Card>
        )}

        {task.verification_notes && task.status === 'rejected' && (
          <ErrorNote>Last time: {task.verification_notes}</ErrorNote>
        )}

        {task.self_report_only ? (
          <>
            <p className="text-sm text-gray-400">
              This one can't be photographed. Logging it is on your word — and it's logged as
              self-reported.
            </p>
            <Button onClick={markSelfReported} disabled={busy}>
              {busy ? '…' : 'Mark done (self-report)'}
            </Button>
          </>
        ) : (
          <>
            <CameraCapture
              disabled={busy || photos.length >= MAX_PHOTOS}
              onCapture={(photo) => setPhotos((p) => [...p, photo].slice(0, MAX_PHOTOS))}
            />

            {photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {photos.map((photo, i) => (
                  <button
                    key={photo.previewUrl}
                    onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                    className="relative overflow-hidden rounded border border-gray-700"
                  >
                    <img src={photo.previewUrl} alt={`Proof ${i + 1}`} className="h-24 w-full object-cover" />
                    <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-xs">✕</span>
                  </button>
                ))}
              </div>
            )}

            <p className="text-xs text-gray-500">
              1–3 photos, taken now. The server rejects anything captured more than 2 minutes ago.
            </p>

            <ErrorNote>{error}</ErrorNote>

            <Button onClick={submit} disabled={busy || photos.length === 0}>
              {busy ? 'Verifying…' : 'Submit for verification'}
            </Button>
          </>
        )}

        {aiDown && (
          <Card className="border-amber-800">
            <p className="text-sm text-amber-200">
              AI verification isn't answering. You can log this by hand — it will be marked{' '}
              <span className="font-bold">MANUAL</span> in the weekly review, not verified.
            </p>
            <Button variant="secondary" className="mt-3 w-full" onClick={creditManually} disabled={busy}>
              Log it manually
            </Button>
          </Card>
        )}

        <Button variant="ghost" className="mt-auto" onClick={() => navigate('/')}>
          Back
        </Button>
      </div>
    </Screen>
  )
}
