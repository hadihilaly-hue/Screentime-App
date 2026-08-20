import { CONFIG } from './config.js'
import { query, todayISO, getSession } from './supabase.js'

const params = new URLSearchParams(location.search)
const domain = params.get('site') ?? ''
const site = CONFIG.sites.find((s) => s.domain === domain)

// Everything after "#from=" is the original URL, verbatim. A fragment is never
// part of a request, so the redirect's \0 could not have contained one — the
// remainder of the string is unambiguous even with ? and & inside it.
const originalUrl = location.hash.startsWith('#from=') ? location.hash.slice('#from='.length) : null
const returnUrl = originalUrl || (domain ? `https://${domain}/` : null)

document.getElementById('site').textContent = site?.label ?? domain ?? 'This site'
document.title = `${site?.label ?? 'Blocked'} — EarnedTime`
document.getElementById('dashboard').href = CONFIG.dashboardUrl

const balanceEl = document.getElementById('balance')
const noteEl = document.getElementById('note')
const destEl = document.getElementById('destination')

if (originalUrl && destEl) {
  destEl.textContent = originalUrl
  destEl.hidden = false
}

/** Is a session for this site running right now, per Supabase? */
async function activeSession() {
  if (!site) return null
  const rows = await query('sessions?select=app_name,minutes,started_at&ended_at=is.null')
  if (rows === null) return null
  const now = Date.now()
  for (const row of rows) {
    if (!site.apps.includes(row.app_name)) continue
    const endsAt = new Date(row.started_at).getTime() + row.minutes * 60_000
    if (endsAt > now) return { endsAt }
  }
  return null
}

/**
 * The instant path. Waiting out the background poll made a freshly started
 * session look like it had not worked at all, so the block page checks for
 * itself, has the worker drop the rules, and only then navigates back.
 */
async function releaseIfUnlocked() {
  let active
  try {
    active = await activeSession()
  } catch {
    return false
  }
  if (!active) return false

  // Rules must actually be gone before navigating, or the redirect fires again.
  const reply = await chrome.runtime.sendMessage({ type: 'sync' })
  if (!reply?.ok || !reply.unlocked?.[domain]) return false

  noteEl.textContent = 'Session running — sending you back…'
  if (returnUrl) location.replace(returnUrl)
  return true
}

async function showBalance() {
  const session = await getSession()
  if (!session) {
    balanceEl.textContent = '—'
    noteEl.textContent = 'Not signed in. Open the EarnedTime extension icon to sign in.'
    return
  }
  try {
    const rows = await query(`balances?select=minutes_available&date=eq.${todayISO()}`)
    if (rows === null) {
      noteEl.textContent = 'Signed out. Open the extension icon to sign in again.'
      return
    }
    balanceEl.textContent = String(rows[0]?.minutes_available ?? 0)
  } catch (e) {
    balanceEl.textContent = '?'
    noteEl.textContent = `Could not reach Supabase: ${e.message}`
  }
}

document.getElementById('retry').addEventListener('click', async () => {
  noteEl.textContent = 'Checking…'
  const released = await releaseIfUnlocked()
  if (!released) noteEl.textContent = 'No session running for this site yet.'
  showBalance()
})

showBalance()
releaseIfUnlocked()

// Keep checking while the page is open, so starting a session in another tab
// releases this one without touching it.
setInterval(releaseIfUnlocked, 5_000)
