import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { addTasks, listTasks } from '../lib/db'

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

  return (
    <section>
      <h1 className="text-2xl font-bold">What's your plan today?</h1>
      <p className="mt-2 text-gray-600">One task per line. Nothing else opens until you have a list.</p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={'ACT math section\nbio homework\nupload program to calculator'}
          className="border p-2"
        />
        <button type="submit" disabled={busy} className="border bg-gray-900 p-2 text-white disabled:opacity-40">
          {busy ? 'Saving...' : 'Structure my day'}
        </button>
      </form>

      {existing > 0 && (
        <button onClick={() => navigate('/review')} className="mt-4 underline">
          You already have {existing} task{existing === 1 ? '' : 's'} today — go to review
        </button>
      )}
      {error && <p className="mt-4 text-red-600">{error}</p>}
    </section>
  )
}
