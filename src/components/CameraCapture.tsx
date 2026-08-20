import { useEffect, useRef, useState } from 'react'
import { normalizePhoto } from '../lib/image'
import type { CapturedPhoto } from '../lib/api'
import { Button, ErrorNote } from './ui'

/**
 * In-app camera. Live capture via getUserMedia where it works; otherwise the
 * `capture="environment"` file input, which opens the camera directly on iOS
 * rather than the photo library.
 *
 * Either way the moment of capture is stamped here and checked by the server.
 * On the fallback path the stamp is the file's own mtime — which is what makes
 * "upload something from last Tuesday" fail instead of silently passing.
 */
export function CameraCapture({
  disabled,
  onCapture,
}: {
  disabled?: boolean
  onCapture: (photo: CapturedPhoto) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
        setLive(true)
      } catch {
        setLive(false) // permission denied or no camera — the file input still works
      }
    })()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  async function shoot() {
    const video = videoRef.current
    if (!video) return
    setBusy(true)
    setError(null)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')?.drawImage(video, 0, 0)
      const raw = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
      if (!raw) throw new Error('Could not read the camera.')
      const blob = await normalizePhoto(raw)
      onCapture({ blob, capturedAt: Date.now(), previewUrl: URL.createObjectURL(blob) })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function pick(file: File) {
    setBusy(true)
    setError(null)
    try {
      const blob = await normalizePhoto(file)
      const stamped = file.lastModified > 0 ? file.lastModified : Date.now()
      onCapture({
        blob,
        capturedAt: Math.min(stamped, Date.now()),
        previewUrl: URL.createObjectURL(blob),
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {live && (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full rounded-lg border border-gray-700 bg-black"
          />
          <Button onClick={shoot} disabled={disabled || busy}>
            {busy ? 'Capturing…' : '📷 Take photo'}
          </Button>
        </>
      )}

      <label
        className={`rounded-lg border border-dashed border-gray-600 px-4 py-3 text-center text-sm ${
          disabled || busy ? 'text-gray-600' : 'cursor-pointer text-gray-300 hover:border-gray-400'
        }`}
      >
        {live ? 'Use the system camera instead' : '📷 Open camera'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={disabled || busy}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void pick(file)
            e.target.value = ''
          }}
        />
      </label>

      <ErrorNote>{error}</ErrorNote>
    </div>
  )
}
