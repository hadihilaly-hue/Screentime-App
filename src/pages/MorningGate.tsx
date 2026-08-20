import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { addTasks, listTasks } from '../lib/db'
import { Screen } from '../ui'

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
}

/**
 * Spec section 4 screen 1. Voice input is Weekend 2 — for now you type the
 * ramble, one task per line. Nothing else in the app is reachable until this
 * produces a list.
 */
export default function MorningGate({ userId }: { userId: string }) {
  const [text, setText] = useState('')
  const [existing, setExisting] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    listTasks(userId)
      .then((tasks) => setExisting(tasks.length))
      .catch((e: Error) => setError(e.message))
  }, [userId])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const titles = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (titles.length === 0) return

    setBusy(true)
    setError(null)
    try {
      await addTasks(userId, titles, false)
      navigate('/review')
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  // Lines typed so far, so the button says what it is about to do.
  const count = text.split('\n').filter((line) => line.trim()).length

  return (
    <Screen
      eyebrow={new Date().toLocaleDateString(undefined, DATE_FORMAT)}
      title="What's your plan today?"
      subtitle="One task per line. Nothing else opens until you have a list."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="card overflow-hidden">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            autoFocus
            placeholder={'ACT math section\nbio homework\nupload program to calculator'}
            className="field resize-none rounded-none border-0 bg-transparent text-[1.0625rem] leading-relaxed focus:shadow-none"
          />
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
            <span className="eyebrow">Brain dump</span>
            <span className="text-[0.75rem] font-semibold text-faint">
              {count} {count === 1 ? 'line' : 'lines'}
            </span>
          </div>
        </div>

        <button type="submit" disabled={busy || count === 0} className="press btn btn-primary w-full">
          {busy ? 'Saving…' : 'Structure my day'}
        </button>
      </form>

      {existing > 0 && (
        <button onClick={() => navigate('/review')} className="press btn btn-ghost mt-3 w-full">
          {existing} task{existing === 1 ? '' : 's'} already saved — go to review
        </button>
      )}
      {error && <p className="banner banner-error mt-4">{error}</p>}
    </Screen>
  )
}
