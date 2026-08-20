const MAX_EDGE = 1568 // Claude downsamples anything larger anyway.

/**
 * Downscale and re-encode to JPEG before upload. Keeps uploads fast on a phone
 * and strips the original file's metadata as a side effect.
 */
export async function normalizePhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable on this browser.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.72),
  )
  if (!blob) throw new Error('Could not process that photo.')
  return blob
}
