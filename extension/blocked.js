import { CONFIG } from './config.js'
import { query, todayISO, getSession } from './supabase.js'

const params = new URLSearchParams(location.search)
const domain = params.get('site') ?? ''
const site = CONFIG.sites.find((s) => s.domain === domain)

document.getElementById('site').textContent = site?.label ?? domain ?? 'This site'
document.title = `${site?.label ?? 'Blocked'} — EarnedTime`

const dashboard = document.getElementById('dashboard')
dashboard.href = CONFIG.dashboardUrl

const balanceEl = document.getElementById('balance')
const noteEl = document.getElementById('note')

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

showBalance()
