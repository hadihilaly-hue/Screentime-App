import { CONFIG } from './config.js'
import { query, todayISO, getSession } from './supabase.js'

const params = new URLSearchParams(location.search)
const domain = params.get('site') ?? ''
const site = CONFIG.sites.find((s) => s.domain === domain)

/**
 * The return URL, only if it is somewhere this page could legitimately have
 * come from.
 *
 * blocked.html is web-accessible, so anyone can hand the browser a crafted
 * blocked.html#from=... and this page will navigate to whatever it says. It is
 * accepted only when it parses, is http(s), and is on the blocked site itself
 * (or a subdomain of it) — so the fragment can send you back where you were
 * and nowhere else. Parsing with URL rather than matching strings is what makes
 * "https://evil.example\@youtube.com/" resolve to its real host, evil.example,
 * and be rejected.
 */
function safeReturnUrl(raw) {
  if (!raw || !site) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  const blocked = site.domain.toLowerCase()
  if (host !== blocked && !host.endsWith(`.${blocked}`)) return null
  return url.href
}

// Everything after "#from=" is the original URL, verbatim. A fragment is never
// part of a request, so the redirect's \0 could not have contained one — the
// remainder of the string is unambiguous even with ? and & inside it.
const rawFrom = location.hash.startsWith('#from=') ? location.hash.slice('#from='.length) : null
const originalUrl = safeReturnUrl(rawFrom)
const returnUrl = originalUrl || (site ? `https://${site.domain}/` : null)

const el = (id) => document.getElementById(id)
el('site').textContent = site?.label ?? domain ?? 'This site'
document.title = `${site?.label ?? 'Blocked'} — EarnedTime`
el('dashboard').href = CONFIG.dashboardUrl
el('version').textContent = `v${chrome.runtime.getManifest().version}`

if (originalUrl) {
  el('destination').textContent = originalUrl
  el('destination').hidden = false
}

/**
 * Errors live on their own line, not on the diagnostics line.
 *
 * They used to share one element, so the next automatic poll a few seconds
 * later overwrote whatever the failure had just said with the routine status
 * text — the one message worth reading was always the one that vanished.
 */
function showError(message) {
  el('error').textContent = message
  el('error').hidden = !message
}

function clearError() {
  showError('')
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
    if (status.failures) {
      bits.push(
        status.heldByGrace
          ? `${status.failures} failed check(s), holding last known state`
          : `${status.failures} failed check(s), blocking until one succeeds`,
      )
    }
  } else {
    bits.push('worker has not checked yet')
  }

  el('note').textContent = bits.join(' · ')
}

/* --- release ------------------------------------------------------------- */

const POLL_VISIBLE_MS = 5_000
const POLL_HIDDEN_MS = 60_000
/** How long after a release a bounce back here counts as a flap, not a visit. */
const RELEASE_COOLDOWN_MS = 20_000
const MARKS_KEY = 'et_release_marks'

let released = false
let inFlight = false
let autoNavigate = true
let timer = null

async function markReleased() {
  const stored = await chrome.storage.local.get(MARKS_KEY)
  const marks = stored[MARKS_KEY] ?? {}
  marks[domain] = Date.now()
  await chrome.storage.local.set({ [MARKS_KEY]: marks })
}

async function bouncedBack() {
  const stored = await chrome.storage.local.get(MARKS_KEY)
  const at = (stored[MARKS_KEY] ?? {})[domain]
  return typeof at === 'number' && Date.now() - at < RELEASE_COOLDOWN_MS
}

async function clearMark() {
  const stored = await chrome.storage.local.get(MARKS_KEY)
  const marks = stored[MARKS_KEY] ?? {}
  delete marks[domain]
  await chrome.storage.local.set({ [MARKS_KEY]: marks })
}

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

async function navigateBack() {
  // Latch before navigating: the poll must not fire again into a page that is
  // already on its way out, and must never send us back a second time.
  released = true
  stopPolling()
  await markReleased()
  el('note').textContent = 'Session running — sending you back…'
  if (returnUrl) location.replace(returnUrl)
}

/**
 * The instant path. Waiting out the background poll made a freshly started
 * session look like it had not worked at all, so the block page checks for
 * itself, has the worker drop the rules, and only then navigates back.
 */
async function releaseIfUnlocked({ manual = false } = {}) {
  if (released) return false

  let state
  try {
    state = await readSessions()
  } catch (e) {
    showError(`Could not reach Supabase: ${e.message}`)
    return false
  }
  // Supabase answered, so any earlier connection error is stale.
  clearError()

  await renderDiagnostics(state)
  if (!state.mine) return false

  // Released a moment ago and landed straight back here: the worker put the
  // rules back as fast as this page took them away. Navigating again would
  // just restart that loop, so hold still and let the button be the way out.
  if (!manual && !autoNavigate) {
    showError(
      'A session is running, but the block came back immediately after the last release. ' +
        'Not bouncing you again — use the button once the worker settles.',
    )
    return false
  }

  // Rules must actually be gone before navigating, or the redirect fires again.
  let reply
  try {
    reply = await chrome.runtime.sendMessage({ type: 'sync' })
  } catch (e) {
    showError(
      `Session is running, but the background worker did not answer (${e.message}). Try the button again.`,
    )
    return false
  }
  if (!reply?.ok) {
    showError(`Session is running, but the rule refresh failed: ${reply?.error ?? 'no reply'}`)
    return false
  }
  if (!reply.unlocked?.[domain]) {
    showError(`Session is running for ${domain}, but the worker still has it blocked. Reload the extension.`)
    return false
  }

  await navigateBack()
  return true
}

/* --- polling -------------------------------------------------------------- */

/**
 * Self-rescheduling rather than setInterval: a slow check can no longer stack
 * up behind itself, a hidden tab drops to a background rate instead of hitting
 * Supabase every 5 seconds forever, and once released the loop simply stops.
 */
function schedule() {
  stopPolling()
  if (released) return
  timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS)
}

async function tick() {
  // clearTimeout, not just `timer = null`. tick() is also called directly by
  // the visibility handler, and merely dropping the handle there left the
  // pending timeout to fire later and start a second chain — every
  // hidden->visible toggle added one, multiplying the poll rate.
  stopPolling()
  if (released || inFlight) {
    schedule()
    return
  }
  inFlight = true
  try {
    await releaseIfUnlocked()
  } finally {
    inFlight = false
  }
  schedule()
}

document.addEventListener('visibilitychange', () => {
  if (released) return
  // Coming back to the tab is worth an immediate check; leaving it just slows
  // the next one down. Either way tick()/schedule() cancel what was armed, so
  // toggling cannot leave more than one chain running.
  if (!document.hidden) void tick()
  else schedule()
})

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
  if (released) return
  clearError()
  el('note').textContent = 'Checking…'
  // An explicit press is the user overriding the anti-flap hold.
  autoNavigate = true
  await clearMark()
  await releaseIfUnlocked({ manual: true })
  showBalance()
})

async function start() {
  showBalance()
  // Set the hold silently. If this really is a flap there is a session running,
  // and releaseIfUnlocked says so with the specific message; if there is no
  // session, there is nothing to explain and the page is just blocked.
  if (await bouncedBack()) autoNavigate = false
  await releaseIfUnlocked()
  schedule()
}

void start()
