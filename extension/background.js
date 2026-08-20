// Applies and lifts the blocks.
//
// Blocking is declarativeNetRequest redirect rules, one (or two) per configured
// site. A site's rules are removed while a session for it is running in the
// sessions table, and put back the moment that window closes.

import { CONFIG } from './config.js'
import { query } from './supabase.js'

const RULE_BASE = 1000
const POLL_ALARM = 'et-poll'
const EXPIRY_ALARM = 'et-expiry'

function blockedPath(site) {
  return `/blocked.html?site=${encodeURIComponent(site.domain)}`
}

/** Two rule ids are reserved per site so the sub_frame rule has a stable id. */
function ruleIds(index) {
  return [RULE_BASE + index * 2, RULE_BASE + index * 2 + 1]
}

function rulesFor(site, index) {
  const [mainId, frameId] = ruleIds(index)
  const redirect = { extensionPath: blockedPath(site) }

  // requestDomains matches the domain and all of its subdomains.
  const rules = [
    {
      id: mainId,
      priority: 1,
      action: { type: 'redirect', redirect },
      condition: { requestDomains: [site.domain], resourceTypes: ['main_frame'] },
    },
  ]

  if (site.blockEmbedsOnSelf) {
    // initiatorDomains restricts this to frames whose parent page is the site
    // itself, so an embed of this site on some other page is left alone.
    rules.push({
      id: frameId,
      priority: 1,
      action: { type: 'redirect', redirect },
      condition: {
        requestDomains: [site.domain],
        initiatorDomains: [site.domain],
        resourceTypes: ['sub_frame'],
      },
    })
  }

  return rules
}

/**
 * Domains with a session still running, mapped to when that window closes.
 * Returns null when signed out — which blocks everything, deliberately.
 */
async function unlockedDomains() {
  const rows = await query('sessions?select=app_name,minutes,started_at&ended_at=is.null')
  if (rows === null) return null

  const now = Date.now()
  const unlocked = new Map()
  for (const row of rows) {
    const endsAt = new Date(row.started_at).getTime() + row.minutes * 60_000
    if (endsAt <= now) continue
    const site = CONFIG.sites.find((s) => s.apps.includes(row.app_name))
    if (!site) continue
    unlocked.set(site.domain, Math.max(unlocked.get(site.domain) ?? 0, endsAt))
  }
  return unlocked
}

/**
 * A tab already sitting on a site when its session ends would otherwise stay
 * there until the next navigation, since redirect rules only see new requests.
 */
async function evictOpenTabs(domain) {
  const tabs = await chrome.tabs.query({ url: [`*://${domain}/*`, `*://*.${domain}/*`] })
  const site = CONFIG.sites.find((s) => s.domain === domain)
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(blockedPath(site)) })
    }
  }
}

export async function sync() {
  let unlocked
  try {
    unlocked = await unlockedDomains()
  } catch {
    // Offline, misconfigured, or Supabase erroring: fail closed and block.
    unlocked = new Map()
  }
  if (unlocked === null) unlocked = new Map() // signed out

  const allIds = CONFIG.sites.flatMap((_, i) => ruleIds(i))
  const addRules = CONFIG.sites.flatMap((site, i) =>
    unlocked.has(site.domain) ? [] : rulesFor(site, i),
  )

  const before = await chrome.declarativeNetRequest.getDynamicRules()
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: allIds, addRules })

  // Only evict tabs for sites that were unblocked a moment ago, so an open tab
  // is not yanked on every poll while nothing has changed.
  const wasBlocked = new Set(before.map((r) => r.id))
  for (const [i, site] of CONFIG.sites.entries()) {
    const [mainId] = ruleIds(i)
    const nowBlocked = !unlocked.has(site.domain)
    if (nowBlocked && !wasBlocked.has(mainId)) await evictOpenTabs(site.domain)
  }

  // Re-check exactly when the earliest running session ends.
  const nextEnd = Math.min(...[...unlocked.values()], Infinity)
  if (Number.isFinite(nextEnd)) {
    chrome.alarms.create(EXPIRY_ALARM, { when: nextEnd + 1_000 })
  }

  await chrome.storage.local.set({
    et_status: {
      checkedAt: Date.now(),
      unlocked: Object.fromEntries(unlocked),
    },
  })
}

function schedulePolling() {
  chrome.alarms.create(POLL_ALARM, {
    periodInMinutes: Math.max(0.5, CONFIG.pollMinutes ?? 1),
  })
}

chrome.runtime.onInstalled.addListener(() => {
  schedulePolling()
  sync()
})
chrome.runtime.onStartup.addListener(() => {
  schedulePolling()
  sync()
})
chrome.alarms.onAlarm.addListener(() => sync())

// The popup asks for an immediate re-check after signing in or out.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'sync') {
    sync().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e) }),
    )
    return true
  }
  return false
})
