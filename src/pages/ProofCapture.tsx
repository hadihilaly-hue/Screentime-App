import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getTask, type Task } from '../lib/db'
import { downscale } from '../lib/image'
import { MAX_PHOTOS, isOffline, submitProof, type ProofOutcome } from '../lib/proof'
import { TIER_MINUTES } from '../lib/constants'
import { IconCamera, IconClose, Screen, Spinner } from '../ui'

interface Shot {
  /** Stable key for React, and the handle for removing one. */
  id: number
  blob: Blob
  /** Object URL for the thumbnail. Revoked when the shot is dropped. */
  url: string
  originalBytes: number
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`

/**
 * Spec section 4.4 — Proof Capture.
 *
 * Reached by tapping Complete on the dashboard, which no longer marks anything
 * done on its own. Take one to three photos, look at them, replace any that are
 * blurry, submit. The photos are downscaled here rather than on the way out of
 * Storage, because the expensive part is the upload from a phone.
 */
export default function ProofCapture() {
  const { taskId = '' } = useParams()
  const navigate = useNavigate()
  /**
   * `?retake=1` — deliberately choosing new photos over answering the question
   * this task is waiting on. In the query string rather than router state so a
   * reload does not bounce straight back to the question.
   */
  const [params] = useSearchParams()
  const retakingOverQuestion = params.get('retake') === '1'

  const [task, setTask] = useState<Task | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'compressing' | 'submitting'>('idle')
  const [offline, setOffline] = useState(isOffline)

  const fileRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)
  // Kept in a ref as well so the unmount cleanup below sees the current list
  // rather than the one captured when the effect first ran.
  const shotsRef = useRef<Shot[]>([])
  shotsRef.current = shots

  useEffect(() => {
    let cancelled = false
    getTask(taskId)
      .then((t) => {
        if (cancelled) return
        if (!t) {
          setLoadError('That task could not be found.')
          return
        }
        // A task with a question waiting belongs on the other screen by
        // default — answering a sentence is cheaper than another three photos.
        // Unless the question cannot be answered, which is the case ?retake=1
        // exists for: a blurry photo can produce a question about something you
        // genuinely cannot see, and without this the only way out was to answer
        // it wrongly, collect the rejection, and only then be allowed a camera.
        if (
          t.verification_verdict === 'needs_followup' &&
          t.status !== 'verified' &&
          !retakingOverQuestion
        ) {
          navigate(`/verification/${taskId}`, { replace: true })
          return
        }
        // Same reasoning as the dashboard's: a verdict of verified whose credit
        // never landed needs the credit retried, not new photos.
        if (t.verification_verdict === 'verified' && t.status !== 'verified') {
          navigate(`/verification/${taskId}`, { replace: true })
          return
        }
        setTask(t)
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
    return () => {
      cancelled = true
    }
  }, [taskId, navigate, retakingOverQuestion])

  // Object URLs are only freed on unmount and on explicit removal; a photo that
  // is still on screen still needs its URL.
  useEffect(
    () => () => {
      for (const shot of shotsRef.current) URL.revokeObjectURL(shot.url)
    },
    [],
  )

  useEffect(() => {
    const sync = () => setOffline(isOffline())
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const onPick = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    // Cleared straight away so picking the same file twice in a row still fires
    // a change event.
    event.target.value = ''
    if (picked.length === 0) return

    setError(null)
    setStage('compressing')
    const added: Shot[] = []
    const failed: string[] = []
    for (const file of picked) {
      if (shotsRef.current.length + added.length >= MAX_PHOTOS) break
      try {
        const { blob, originalBytes } = await downscale(file)
        added.push({
          id: nextId.current++,
          blob,
          url: URL.createObjectURL(blob),
          originalBytes,
        })
      } catch (e) {
        failed.push((e as Error).message)
      }
    }
    setShots((prev) => [...prev, ...added].slice(0, MAX_PHOTOS))
    if (failed.length > 0) setError(failed[0])
    setStage('idle')
  }, [])

  function remove(id: number) {
    setShots((prev) => {
      const gone = prev.find((s) => s.id === id)
      if (gone) URL.revokeObjectURL(gone.url)
      return prev.filter((s) => s.id !== id)
    })
    setError(null)
  }

  async function submit() {
    setError(null)
    setStage('submitting')
    const outcome: ProofOutcome = await submitProof(
      taskId,
      shots.map((s) => s.blob),
    )
    setStage('idle')
    // Every outcome, including every failure, is a screen on /verification —
    // so a storage error and a rejection are never rendered by the same banner
    // and can never be mistaken for one another.
    navigate(`/verification/${taskId}`, { state: { outcome } })
  }

  if (loadError) {
    return (
      <Screen eyebrow="Proof" title="Not found">
        <p className="banner banner-error">{loadError}</p>
        <button onClick={() => navigate('/dashboard')} className="press btn btn-secondary mt-4 w-full">
          Back to today
        </button>
      </Screen>
    )
  }
  if (!task) return <Spinner label="Loading task" />

  if (task.status === 'verified') {
    return (
      <Screen eyebrow="Proof" title="Already done">
        <p className="text-[0.9375rem] leading-snug text-muted">
          “{task.title}” is already verified, so there is nothing left to photograph.
        </p>
        <button onClick={() => navigate('/dashboard')} className="press btn btn-primary mt-6 w-full">
          Back to today
        </button>
      </Screen>
    )
  }
  if (task.status === 'cancelled') {
    return (
      <Screen eyebrow="Proof" title="Cancelled">
        <p className="text-[0.9375rem] leading-snug text-muted">
          “{task.title}” was cancelled. Uncancelling is not a thing — add it again tomorrow.
        </p>
        <button onClick={() => navigate('/dashboard')} className="press btn btn-secondary mt-6 w-full">
          Back to today
        </button>
      </Screen>
    )
  }

  const busy = stage !== 'idle'
  const retry = task.verification_verdict === 'rejected'
  const abandoningQuestion = retakingOverQuestion && task.verification_verdict === 'needs_followup'

  return (
    <Screen
      eyebrow={retry || abandoningQuestion ? 'Proof · second try' : 'Proof'}
      title={task.title}
      subtitle={
        <>
          Worth <span className="font-bold text-acid">{TIER_MINUTES[task.tier]} min</span>. Take{' '}
          {MAX_PHOTOS === 3 ? 'one to three' : `up to ${MAX_PHOTOS}`} photos of the finished work.
        </>
      }
    >
      {task.proof_hint && (
        <p className="banner mb-4 bg-panel text-muted">Looking for: {task.proof_hint}</p>
      )}

      {retry && task.verification_notes && (
        <p className="banner banner-warn mb-4">
          Last time: {task.verification_notes}
        </p>
      )}

      {abandoningQuestion && (
        <>
          <p className="banner banner-warn mb-2">
            New photos replace the question “{task.followup_question}” — you will not be asked it
            again. Submitting uses one of this task's verification attempts for today.
          </p>
          <button
            onClick={() => navigate(`/verification/${taskId}`, { replace: true })}
            className="press btn btn-ghost mb-4 w-full"
          >
            Answer the question instead
          </button>
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={onPick}
        className="hidden"
      />

      {/* --- thumbnails ------------------------------------------------------
          Shown at a size you can actually judge blur at. A thumbnail too small
          to see the problem in is a retake you only discover after submitting. */}
      {shots.length > 0 && (
        <ul className="mb-4 flex flex-col gap-3">
          {shots.map((shot, i) => (
            <li key={shot.id} className="card relative overflow-hidden">
              <img
                src={shot.url}
                alt={`Proof photo ${i + 1}`}
                className="h-44 w-full object-cover"
              />
              <button
                aria-label={`Remove photo ${i + 1}`}
                disabled={busy}
                onClick={() => remove(shot.id)}
                className="press absolute top-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-ink/80 text-fg disabled:opacity-40"
              >
                <IconClose className="h-4 w-4" />
              </button>
              <p className="px-4 py-2.5 text-[0.75rem] text-faint">
                Photo {i + 1} · {kb(shot.blob.size)} (from {kb(shot.originalBytes)})
              </p>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy || shots.length >= MAX_PHOTOS}
        className="press btn btn-secondary w-full"
      >
        <IconCamera />
        {shots.length === 0
          ? 'Take a photo'
          : shots.length >= MAX_PHOTOS
            ? `${MAX_PHOTOS} photos — that is the limit`
            : 'Take another'}
      </button>

      {stage === 'compressing' && (
        <p className="mt-3 text-center text-[0.8125rem] text-faint">Shrinking that photo…</p>
      )}

      {error && <p className="banner banner-error mt-4">{error}</p>}

      {offline && (
        <p className="banner banner-warn mt-4">
          You are offline. Verification needs a connection, and nothing is queued — the photos stay
          on this screen until you are back.
        </p>
      )}

      <button
        onClick={submit}
        disabled={busy || shots.length === 0 || offline}
        className="press btn btn-primary mt-3 w-full"
      >
        {stage === 'submitting' ? 'Checking your photos…' : 'Submit for verification'}
      </button>

      {stage === 'submitting' && (
        <p className="mt-3 text-center text-[0.8125rem] text-faint">
          Uploading, then asking Claude. This takes a few seconds — leaving this screen cancels
          nothing, but stay if you can.
        </p>
      )}

      <button
        onClick={() => navigate('/dashboard')}
        disabled={busy}
        className="press btn btn-ghost mt-2 w-full"
      >
        Not now
      </button>
    </Screen>
  )
}
