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

const el = (id) => document.getElementById(id)
el('site').textContent = site?.label ?? domain ?? 'This site'
document.title = `${site?.label ?? 'Blocked'} — EarnedTime`
el('dashboard').href = CONFIG.dashboardUrl
el('version').textContent = `v${chrome.runtime.getManifest().version}`

if (originalUrl) {
  el('destination').textContent = originalUrl
  el('destination').hidden = false
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString()
}

/**
 * One read of the session table, with everything needed to explain a failure.
 *
 * The query is deliberately not filtered by date. sessions.date is written from
 * the user's LOCAL date while Postgres current_date is UTC, and those disagree
 * every evening west of Greenwich — a date filter here would return zero rows
 * all evening. "Active" is only: ended_at is null, and started_at + minutes is
 * still in the future.
 */
async function readSessions() {
  const stored = await getSession()
  if (!stored) return { signedIn: false }

  const rows = await query('sessions?select=app_name,minutes,started_at&ended_at=is.null')
  if (rows === null) return { signedIn: false }

  const now = Date.now()
  const open = rows.map((r) => ({
    app: r.app_name,
    endsAt: new Date(r.started_at).getTime() + r.minutes * 60_000,
  }))
  const running = open.filter((o) => o.endsAt > now)
  const mine = running.find((o) => site?.apps.includes(o.app)) ?? null

  return { signedIn: true, email: stored.email, openCount: rows.length, running, mine }
}

async function renderDiagnostics(state) {
  const bits = []
  bits.push(state.signedIn ? `Signed in as ${state.email ?? '(unknown)'}` : 'NOT signed in')

  if (state.signedIn) {
    bits.push(`${state.openCount} unfinished session row(s)`)
    bits.push(
      state.running.length
        ? `${state.running.length} still running: ${state.running
            .map((r) => `${r.app} ${Math.max(0, Math.ceil((r.endsAt - Date.now()) / 60_000))}m`)
            .join(', ')}`
        : '0 still running',
    )
    bits.push(
      state.mine
        ? `MATCHES ${domain}`
        : `none match ${domain} (needs app_name in ${JSON.stringify(site?.apps ?? [])})`,
    )
  }

  const { et_status: status } = await chrome.storage.local.get('et_status')
  if (status?.checkedAt) {
    const next = status.checkedAt + (CONFIG.pollMinutes ?? 1) * 60_000
    bits.push(`worker last checked ${clock(status.checkedAt)}, next by ${clock(next)}`)
  } else {
    bits.push('worker has not checked yet')
  }

  el('note').textContent = bits.join(' · ')
}

/**
 * The instant path. Waiting out the background poll made a freshly started
 * session look like it had not worked at all, so the block page checks for
 * itself, has the worker drop the rules, and only then navigates back.
 */
async function releaseIfUnlocked() {
  let state
  try {
    state = await readSessions()
  } catch (e) {
    el('note').textContent = `Could not reach Supabase: ${e.message}`
    return false
  }

  await renderDiagnostics(state)
  if (!state.mine) return false

  // Rules must actually be gone before navigating, or the redirect fires again.
  let reply
  try {
    reply = await chrome.runtime.sendMessage({ type: 'sync' })
  } catch (e) {
    el('note').textContent = `Session is running, but the background worker did not answer (${e.message}). Try the button again.`
    return false
  }
  if (!reply?.ok) {
    el('note').textContent = `Session is running, but the rule refresh failed: ${reply?.error ?? 'no reply'}`
    return false
  }
  if (!reply.unlocked?.[domain]) {
    el('note').textContent = `Session is running for ${domain}, but the worker still has it blocked. Reload the extension.`
    return false
  }

  el('note').textContent = 'Session running — sending you back…'
  if (returnUrl) location.replace(returnUrl)
  return true
}

async function showBalance() {
  const stored = await getSession()
  if (!stored) {
    el('balance').textContent = '—'
    return
  }
  try {
    const rows = await query(`balances?select=minutes_available&date=eq.${todayISO()}`)
    el('balance').textContent = rows === null ? '—' : String(rows[0]?.minutes_available ?? 0)
  } catch {
    el('balance').textContent = '?'
  }
}

el('retry').addEventListener('click', async () => {
  el('note').textContent = 'Checking…'
  await releaseIfUnlocked()
  showBalance()
})

showBalance()
releaseIfUnlocked()

// Keep checking while the page is open, so starting a session in another tab
// releases this one without touching it.
setInterval(releaseIfUnlocked, 5_000)
