/**
 * Nudging the Chrome extension to re-check, so ending a session early re-blocks
 * in a couple of seconds instead of waiting out the worker's one-minute poll.
 *
 * Everything here is best-effort by design. The app has to work with no
 * extension installed, on a browser that has no extensions at all, and with the
 * id unset — so every failure is swallowed and the worker's poll remains the
 * mechanism that actually guarantees the block comes back. This only decides
 * whether that takes two seconds or up to sixty.
 *
 * The message carries no state and is not trusted by the worker: it re-reads
 * Supabase and decides for itself, so this can make the extension check sooner
 * and nothing else.
 */

/** Set VITE_EXTENSION_ID to the id on chrome://extensions. Unset disables this. */
const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID as string | undefined

/**
 * `chrome.runtime` exists in a page only when some extension has declared this
 * origin in externally_connectable, so this is also the feature test for
 * "is our extension installed and configured for this origin".
 */
interface ChromeRuntime {
  runtime?: {
    sendMessage?: (
      id: string,
      message: unknown,
      callback?: (reply: unknown) => void,
    ) => void
    lastError?: { message?: string }
  }
}

export function notifyExtension(): void {
  if (!EXTENSION_ID) return

  const runtime = (globalThis as unknown as { chrome?: ChromeRuntime }).chrome?.runtime
  if (!runtime?.sendMessage) return

  try {
    // The callback is required to swallow "Could not establish connection" —
    // without one, Chrome reports an unchecked runtime.lastError on the console
    // every time the extension is absent, which is the normal case for anyone
    // running the app on their phone.
    runtime.sendMessage(EXTENSION_ID, { type: 'sync-hint' }, () => {
      void runtime.lastError
    })
  } catch {
    // Extension gone, id wrong, or a browser with no chrome.runtime at all.
    // The poll covers it.
  }
}
