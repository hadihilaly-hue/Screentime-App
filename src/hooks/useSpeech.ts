import { useCallback, useEffect, useRef, useState } from 'react'

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | null
}

/**
 * Web Speech API with a text fallback. iOS Safari supports it but drops the
 * session aggressively, so `final` accumulates across restarts rather than
 * relying on one long continuous result.
 */
export function useSpeech() {
  const supported = typeof window !== 'undefined' && recognitionCtor() !== null
  const [listening, setListening] = useState(false)
  const [final, setFinal] = useState('')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const wantsToListen = useRef(false)

  useEffect(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'

    rec.onresult = (event) => {
      let liveText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0].transcript
        if (result.isFinal) setFinal((prev) => (prev ? `${prev} ${text.trim()}` : text.trim()))
        else liveText += text
      }
      setInterim(liveText)
    }
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      setError(
        e.error === 'not-allowed'
          ? 'Microphone permission denied — type it instead.'
          : `Mic error: ${e.error}`,
      )
      wantsToListen.current = false
      setListening(false)
    }
    rec.onend = () => {
      // Safari ends the session after a pause; restart if the user is still holding the floor.
      if (wantsToListen.current) {
        try {
          rec.start()
        } catch {
          setListening(false)
        }
      } else {
        setListening(false)
      }
    }

    recognition.current = rec
    return () => {
      wantsToListen.current = false
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
    }
  }, [])

  const start = useCallback(() => {
    if (!recognition.current) return
    setError(null)
    wantsToListen.current = true
    try {
      recognition.current.start()
      setListening(true)
    } catch {
      /* already started */
    }
  }, [])

  const stop = useCallback(() => {
    wantsToListen.current = false
    setInterim('')
    try {
      recognition.current?.stop()
    } catch {
      /* already stopped */
    }
    setListening(false)
  }, [])

  const reset = useCallback(() => {
    setFinal('')
    setInterim('')
  }, [])

  return { supported, listening, transcript: final, interim, error, start, stop, reset, setFinal }
}
