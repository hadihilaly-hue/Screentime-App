import { CONFIG } from './config.js'
import { query, getSession } from './supabase.js'
import { phaseAt, spendOpensAt, clockLabel, phaseSummary } from './schedule.js'
import { randomQuote } from './quotes.js'
import { readBalance, startSession } from './spend.js'
import { isAlwaysAllowed } from './always-allowed.js'

const params = new URLSearchParams(location.search)
const domain = params.get('site') ?? ''
const site = CONFIG.sites.find((s) => s.domain === domain)

/** Spec section 3, mirrored by SESSION_LENGTHS in src/lib/constants.ts. */
const SESSION_LENGTHS = [5, 10, 15, 20]

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

// One quote per page load, picked at random and never rotated while you look at
// it — a wall that reshuffles itself is a thing to sit and watch.
const quote = randomQuote()
el('quote-text').textContent = `“${quote.text}”`
el('quote-who').textContent = `— ${quote.who}`
el('quote').hidden = false

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
  const bits = [phaseSummary()]
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
    // A rules write that failed is not a failed check — the sessions query was
    // fine, the browser refused the rules. Without this the only symptom is
    // sites quietly not blocking.
    if (status.rulesError) bits.push(`LAST RULES WRITE FAILED: ${status.rulesError}`)
  } else {
    bits.push('worker has not checked yet')
  }

  el('note').textContent = bits.join(' · ')
}

/* --- the window ----------------------------------------------------------- */

let balance = null
let busy = false

/**
 * The whole page above the quote is a function of the window (spec section 3A).
 *
 * Spend window: shield in accent, balance, four length buttons — tapping one is
 * what starts the session. Locked windows: no buttons whatsoever, and a slab
 * saying when the wall comes down. The open window gets neither panel, since
 * nothing is blocked then and the page is on its way out anyway. There is no
 * state, and no amount of clicking, that produces a session button at 2pm.
 */
function renderWindow() {
  const phase = phaseAt()
  const spending = phase.kind === 'spend'

  el('shield').classList.toggle('is-spend', spending)
  el('spend').hidden = !spending
  // The open window gets neither panel: it is not a wall, and it releases
  // itself a moment later — an empty slab would just flash on the way out.
  el('locked').hidden = spending || phase.kind === 'open'

  if (spending) {
    el('window').textContent = `Spend window · closes ${clockLabel(phase.endsAt)}`
    el('lede').textContent = 'Pick a length. That starts the session and lets you through.'
  } else if (phase.kind === 'open') {
    el('window').textContent = `Open · until ${clockLabel(phase.endsAt)}`
    el('lede').textContent = 'Nothing is blocked right now — sending you through.'
  } else {
    el('window').textContent = phase.kind === 'cutoff' ? 'Hard cutoff' : 'Hard block'
    el('lede').textContent = 'No sessions, no exceptions. Earning still works — go do a task.'
    el('locked-until').textContent = `Locked until ${clockLabel(phase.endsAt)}`
    el('locked-why').textContent =
      phase.kind === 'cutoff'
        ? 'The day resets at 7:00 AM. Minutes can be spent again between 6:00 PM and midnight.'
        : 'Minutes can be spent between 6:00 PM and midnight. Anything you earn before then is waiting for you.'
  }

  renderBalance(phase)
  renderLengths(phase)
}

function renderBalance(phase) {
  const spending = phase.kind === 'spend'
  el('balance').textContent = balance === null ? '—' : String(balance)
  el('balance').classList.toggle('is-spendable', spending && (balance ?? 0) > 0)
  el('balance-label').innerHTML = spending
    ? 'minutes<br />available'
    : `minutes<br />spendable at ${clockLabel(spendOpensAt())}`
}

function renderLengths(phase) {
  const lengths = el('lengths')
  lengths.innerHTML = ''
  if (phase.kind !== 'spend') return

  for (const minutes of SESSION_LENGTHS) {
    const button = document.createElement('button')
    button.className = 'length'
    button.type = 'button'
    button.disabled = busy || balance === null || balance < minutes
    button.title = button.disabled && balance !== null && balance < minutes
      ? `Needs ${minutes} minutes, you have ${balance}.`
      : ''
    const num = document.createElement('span')
    num.className = 'num'
    num.textContent = String(minutes)
    const unit = document.createElement('span')
    unit.className = 'unit'
    unit.textContent = 'MIN'
    button.append(num, unit)
    button.addEventListener('click', () => void pick(minutes))
    lengths.append(button)
  }

  const left = Math.floor((phase.endsAt - Date.now()) / 60_000)
  if (balance === null) {
    el('spend-hint').textContent = 'Sign in from the extension icon to spend minutes.'
  } else if (balance === 0) {
    el('spend-hint').textContent = 'Nothing to spend yet. Finish a task in the app to earn some.'
  } else if (left < Math.max(...SESSION_LENGTHS)) {
    el('spend-hint').textContent = `The window closes in ${left} min — anything past midnight is cut off.`
  } else {
    el('spend-hint').textContent = ''
  }
}

/* --- release -------------------------------------------------------------- */

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
  el('note').textContent = 'Unlocked — sending you back…'
  if (returnUrl) location.replace(returnUrl)
}

/**
 * Have the worker rewrite its rules, confirm this domain really is unlocked,
 * then go. Rules must actually be gone before navigating, or the redirect just
 * fires again and you land straight back here.
 */
async function dropRulesAndGo(reason) {
  let reply
  try {
    reply = await chrome.runtime.sendMessage({ type: 'sync' })
  } catch (e) {
    showError(`${reason}, but the background worker did not answer (${e.message}). Try again.`)
    return false
  }
  if (!reply?.ok) {
    showError(`${reason}, but the rule refresh failed: ${reply?.error ?? 'no reply'}`)
    return false
  }
  if (!reply.unlocked?.[domain]) {
    showError(`${reason}, but the worker still has ${domain} blocked. Reload the extension.`)
    return false
  }
  await navigateBack()
  return true
}

/**
 * The instant path. Waiting out the background poll made a freshly started
 * session look like it had not worked at all, so the block page checks for
 * itself, has the worker drop the rules, and only then navigates back.
 *
 * Outside the spend window this never releases, whatever the sessions table
 * says — the schedule decides first (spec section 3A).
 */
async function releaseIfUnlocked({ manual = false } = {}) {
  if (released) return false
  const phase = phaseAt()
  renderWindow()

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

  if (phase.kind === 'open') {
    // 7:00am-9:00am: nothing is blocked, so nothing has to be spent either.
    return await dropRulesAndGo('The open window is running')
  }
  if (phase.kind !== 'spend') return false
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

  return await dropRulesAndGo('Session is running')
}

/* --- starting a session --------------------------------------------------- */

/**
 * The open IS the session start (spec section 3A). One tap spends the minutes,
 * writes the session row, drops the block, and sends you on to where you were
 * heading.
 */
async function pick(minutes) {
  if (busy || released) return
  busy = true
  clearError()
  renderWindow()
  el('spend-hint').textContent = `Starting ${minutes} minutes…`

  try {
    await startSession(site, minutes)
  } catch (e) {
    showError(e.message)
    busy = false
    await refreshBalance()
    renderWindow()
    return
  }

  // An explicit start is the user overriding any anti-flap hold.
  autoNavigate = true
  await clearMark()
  await refreshBalance()
  busy = false

  if (!(await dropRulesAndGo('Session started'))) renderWindow()
}

async function refreshBalance() {
  try {
    balance = await readBalance()
  } catch {
    balance = null
  }
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
  if (released || inFlight || busy) {
    schedule()
    return
  }
  inFlight = true
  try {
    // The balance is re-read every tick so the buttons enable themselves the
    // moment a task is verified in the app, and the window is re-rendered so
    // 6:00pm turns this page from a wall into a menu without a reload.
    await refreshBalance()
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

el('retry').addEventListener('click', async () => {
  if (released || busy) return
  clearError()
  el('note').textContent = 'Checking…'
  // An explicit press is the user overriding the anti-flap hold.
  autoNavigate = true
  await clearMark()
  await refreshBalance()
  await releaseIfUnlocked({ manual: true })
})

async function start() {
  if (site && isAlwaysAllowed(site)) {
    // Belt and braces: the worker never writes a rule for one of these, so
    // landing here at all means something is misconfigured.
    showError(`${site.label ?? domain} is on the always-allowed list and should never be blocked.`)
  }
  renderWindow()
  await refreshBalance()
  // Set the hold silently. If this really is a flap there is a session running,
  // and releaseIfUnlocked says so with the specific message; if there is no
  // session, there is nothing to explain and the page is just blocked.
  if (await bouncedBack()) autoNavigate = false
  await releaseIfUnlocked()
  schedule()
}

void start()
