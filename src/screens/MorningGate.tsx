import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSpeech } from '../hooks/useSpeech'
import * as api from '../lib/api'
import { Button, Card, ErrorNote, Screen } from '../components/ui'

export const transcriptKey = (date: string) => `scrip:transcript:${date}`

/**
 * The gate. Nothing else in the app is reachable until a list exists for today,
 * so this screen has exactly one exit: produce some tasks.
 */
export function MorningGate({
  userId,
  date,
  onDone,
}: {
  userId: string
  date: string
  onDone: () => Promise<void>
}) {
  const navigate = useNavigate()
  const speech = useSpeech()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const spoken = [speech.transcript, speech.interim].filter(Boolean).join(' ')
  const text = (speech.supported ? [spoken, typed].filter(Boolean).join(' ') : typed).trim()

  async function structure() {
    setBusy(true)
    setError(null)
    try {
      speech.stop()
      localStorage.setItem(transcriptKey(date), text)
      const drafts = await api.structureTasks(text)
      await api.insertTasks(userId, date, drafts, false)
      await onDone()
      navigate('/review')
    } catch (err) {
      setError(
        `${(err as Error).message} You can still type the list in by hand.`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <div className="flex flex-1 flex-col gap-5 py-10">
        <div>
          <p className="text-sm uppercase tracking-wide text-gray-500">Morning gate</p>
          <h1 className="mt-1 text-3xl font-bold">What's your plan today?</h1>
          <p className="mt-2 text-gray-400">
            Ramble it out. Every task you finish and prove buys screen time. Nothing else
            in the app opens until this list exists.
          </p>
        </div>

        {speech.supported ? (
          <Card className="flex flex-col gap-3">
            <Button
              variant={speech.listening ? 'danger' : 'secondary'}
              onClick={speech.listening ? speech.stop : speech.start}
            >
              {speech.listening ? '● Listening — tap to stop' : '🎤 Hold the floor'}
            </Button>
            <p className="min-h-20 whitespace-pre-wrap text-sm text-gray-300">
              {spoken || <span className="text-gray-600">Your words show up here.</span>}
            </p>
            {speech.transcript && (
              <Button variant="ghost" onClick={speech.reset}>
                Clear transcript
              </Button>
            )}
          </Card>
        ) : (
          <p className="text-sm text-gray-500">
            This browser has no speech recognition. Type it instead.
          </p>
        )}

        <div>
          <label className="text-sm text-gray-400" htmlFor="ramble">
            {speech.supported ? 'Or add to it in writing' : 'Your plan'}
          </label>
          <textarea
            id="ramble"
            rows={5}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="first ACT math section, then bio homework, then upload the program to my calculator…"
            className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-3 py-3 text-base"
          />
        </div>

        <ErrorNote>{speech.error}</ErrorNote>
        <ErrorNote>{error}</ErrorNote>

        <div className="mt-auto flex flex-col gap-2">
          <Button onClick={structure} disabled={busy || text.length < 3}>
            {busy ? 'Structuring…' : 'Structure my day'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              localStorage.setItem(transcriptKey(date), text)
              navigate('/review')
            }}
          >
            Skip AI — type the list myself
          </Button>
        </div>
      </div>
    </Screen>
  )
}
