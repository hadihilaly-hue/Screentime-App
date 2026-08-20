import { CONFIG } from './config.js'
import { signIn, signOut, getSession, isConfigured } from './supabase.js'

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

  const session = await getSession()
  el('signed-out').hidden = Boolean(session)
  el('signed-in').hidden = !session
  if (!session) return

  el('who').textContent = session.email ?? 'signed in'

  const { et_status: status } = await chrome.storage.local.get('et_status')
  const unlocked = status?.unlocked ?? {}
  el('sites').innerHTML = ''
  for (const site of CONFIG.sites) {
    const endsAt = unlocked[site.domain]
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = site.label
    const state = document.createElement('span')
    if (endsAt) {
      state.className = 'open'
      state.textContent = `open · ${minutesLeft(endsAt)}m left`
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
