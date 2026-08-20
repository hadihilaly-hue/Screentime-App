import { CONFIG } from './config.js'
import { signIn, signOut, getSession, isConfigured } from './supabase.js'
import { phaseAt, phaseSummary, clockLabel, spendOpensAt } from './schedule.js'
import { blockableSites } from './always-allowed.js'

const el = (id) => document.getElementById(id)
const errorEl = el('error')

function minutesLeft(endsAt) {
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000))
}

async function render() {
  errorEl.textContent = ''
  if (!isConfigured()) {
    errorEl.textContent = 'config.js still has placeholder values.'
    return
  }

  // Trouble is reported before the signed-out early return: signed out is the
  // state where everything is supposed to be blocked, so a rules write the
  // browser refused matters more there, not less.
  const { et_status: status } = await chrome.storage.local.get('et_status')
  const trouble = []
  if (status?.rulesError) trouble.push(`Browser refused the block rules: ${status.rulesError}`)
  if (status?.evictErrors?.length) trouble.push(`Tabs not evicted — ${status.evictErrors.join('; ')}`)
  errorEl.textContent = trouble.join(' · ')

  const session = await getSession()
  el('signed-out').hidden = Boolean(session)
  el('signed-in').hidden = !session
  if (!session) return

  el('who').textContent = session.email ?? 'signed in'

  // The window comes first here for the same reason it does in the worker: it
  // is what decides whether any of the per-site rows below can say "open".
  const phase = phaseAt()
  el('window').textContent = phaseSummary()
  el('window-note').textContent =
    phase.kind === 'spend'
      ? 'Open a blocked site to spend minutes.'
      : `Spending reopens at ${clockLabel(spendOpensAt())}.`

  const unlocked = status?.unlocked ?? {}
  // A rejected rules write leaves the previous rules in place, so the worker's
  // decision and what the browser is enforcing have come apart, and every row
  // below is then a claim about the decision only — in both directions.
  // Asserting a wall that may not be there is one half; asserting an opening
  // that is not there is the half you actually notice, when the popup offers
  // nine minutes on a site that will not load.
  const rulesFailed = Boolean(status?.rulesError)
  el('sites').innerHTML = ''
  for (const site of blockableSites(CONFIG.sites)) {
    const endsAt = unlocked[site.domain]
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = site.label
    const state = document.createElement('span')
    if (rulesFailed && endsAt) {
      state.className = 'state-bad'
      state.textContent = `should be open · ${minutesLeft(endsAt)}m left`
    } else if (endsAt && phase.kind === 'open') {
      state.className = 'open'
      state.textContent = 'open window'
    } else if (endsAt) {
      state.className = 'open'
      state.textContent = `open · ${minutesLeft(endsAt)}m left`
    } else if (rulesFailed) {
      state.className = 'state-bad'
      state.textContent = 'should be blocked'
    } else {
      state.className = 'blocked'
      state.textContent = 'blocked'
    }
    li.append(name, state)
    el('sites').append(li)
  }
  el('checked').textContent = status?.checkedAt
    ? `Last checked ${new Date(status.checkedAt).toLocaleTimeString()}`
    : 'Not checked yet'
}

async function resync() {
  await chrome.runtime.sendMessage({ type: 'sync' })
  await render()
}

el('signin').addEventListener('click', async () => {
  errorEl.textContent = ''
  try {
    await signIn(el('email').value.trim(), el('password').value)
    await resync()
  } catch (e) {
    errorEl.textContent = e.message
  }
})

el('signout').addEventListener('click', async () => {
  await signOut()
  await resync()
})

el('refresh').addEventListener('click', resync)

render()
