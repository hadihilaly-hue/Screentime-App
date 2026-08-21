/**
 * Shrinking a phone photo before it is uploaded.
 *
 * A modern phone camera produces 3–8 MB per shot. Three of those is up to
 * 24 MB over whatever the connection happens to be, and then the same bytes
 * again out of Storage and into the Anthropic API, where they are base64'd and
 * charged for as image tokens. None of that buys any verification accuracy: a
 * 1600px photo of a page of homework is as readable as a 4000px one.
 *
 * So every photo is decoded, scaled so its longest edge is at most MAX_EDGE,
 * and re-encoded as JPEG at descending quality until it fits TARGET_BYTES.
 */

/** Longest edge after scaling. Comfortably enough to read handwriting. */
const MAX_EDGE = 1600

/** ~1 MB per photo, per the build request. */
const TARGET_BYTES = 1_000_000

/**
 * Quality ladder. Stops at 0.45 rather than chasing the target forever — below
 * that JPEG artefacts start eating pencil strokes, which is the one thing the
 * photo exists to show. A photo that lands slightly over 1 MB is fine; the
 * bucket's own limit is 5 MB.
 */
const QUALITY_STEPS = [0.82, 0.7, 0.58, 0.45]

export interface Downscaled {
  blob: Blob
  width: number
  height: number
  /** Bytes before, so the capture screen can say what it saved. */
  originalBytes: number
}

/**
 * Decode a file to something drawable.
 *
 * createImageBitmap with `imageOrientation: 'from-image'` is the important
 * path: without it, a photo taken in portrait on iOS arrives with an EXIF
 * rotation flag that canvas ignores, and the upload is sideways. The
 * HTMLImageElement fallback is for browsers without that option — since Safari
 * 15 it applies EXIF orientation to <img> by itself, so both routes end up
 * upright.
 */
async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Fall through — some browsers reject the option rather than ignore it.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('That file could not be read as an image.'))
      img.src = url
    })
    return img
  } finally {
    // Safe here: the bitmap has been decoded into the element by now.
    URL.revokeObjectURL(url)
  }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/**
 * Scale and re-encode one photo.
 *
 * Throws with a readable message if the file cannot be decoded — the capture
 * screen shows that per photo rather than failing the whole submission.
 */
export async function downscale(file: File): Promise<Downscaled> {
  const source = await decode(file)
  const { width: w0, height: h0 } = source
  if (!w0 || !h0) throw new Error('That image had no dimensions the browser could read.')

  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0))
  const width = Math.max(1, Math.round(w0 * scale))
  const height = Math.max(1, Math.round(h0 * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser would not give the app a canvas to resize with.')
  ctx.drawImage(source, 0, 0, width, height)
  if ('close' in source && typeof source.close === 'function') source.close()

  let best: Blob | null = null
  for (const quality of QUALITY_STEPS) {
    const blob = await encode(canvas, quality)
    if (!blob) continue
    best = blob
    if (blob.size <= TARGET_BYTES) break
  }
  if (!best) throw new Error('The browser could not re-encode that photo.')

  return { blob: best, width, height, originalBytes: file.size }
}
