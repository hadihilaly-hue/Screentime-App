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
const HEALTH_KEY = 'et_health'

/**
 * Consecutive failed polls tolerated before a site is re-blocked.
 *
 * Failing closed on the very first error meant one dropped packet mid-session
 * yanked you out of a game you had paid minutes for, and the next poll let you
 * straight back in — a flap, not a block. Inside the grace window the last
 * known-good unlock set is held instead. That set is still expiry-filtered, so
 * grace only ever covers "cannot reach Supabase", never "the session ended".
 */
function graceFailures() {
  const n = CONFIG.graceFailures ?? 3
  return Number.isFinite(n) && n >= 0 ? n : 3
}

async function readHealth() {
  const stored = await chrome.storage.local.get(HEALTH_KEY)
  const health = stored[HEALTH_KEY] ?? {}
  return { failures: health.failures ?? 0, lastGood: health.lastGood ?? {} }
}

/** Held unlocks that have not run out yet. Expiry always wins over grace. */
function stillRunning(lastGood) {
  const now = Date.now()
  const live = new Map()
  for (const [domain, endsAt] of Object.entries(lastGood ?? {})) {
    if (endsAt > now) live.set(domain, endsAt)
  }
  return live
}

/**
 * The block page URL. The originally requested URL rides along in the
 * fragment, not a query parameter: a fragment is never sent with the request,
 * so DNR's \0 substitution can never contain one, which means everything after
 * "#from=" is unambiguously the original URL even when it has its own ? and &.
 */
function blockedUrl(site, originalUrl) {
  const base = `${chrome.runtime.getURL('blocked.html')}?site=${encodeURIComponent(site.domain)}`
  return originalUrl ? `${base}#from=${originalUrl}` : base
}

/** Two rule ids are reserved per site so the sub_frame rule has a stable id. */
function ruleIds(index) {
  return [RULE_BASE + index * 2, RULE_BASE + index * 2 + 1]
}

function rulesFor(site, index) {
  const [mainId, frameId] = ruleIds(index)
  // regexSubstitution rather than extensionPath, so \0 (the whole requested
  // URL) can be carried through to the block page and returned to on unlock.
  const redirect = { regexSubstitution: `${blockedUrl(site)}#from=\\0` }
  const matchAll = '^.*$'

  // requestDomains matches the domain and all of its subdomains.
  const rules = [
    {
      id: mainId,
      priority: 1,
      action: { type: 'redirect', redirect },
      condition: {
        requestDomains: [site.domain],
        resourceTypes: ['main_frame'],
        regexFilter: matchAll,
      },
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
        regexFilter: matchAll,
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
    // Carry the URL the tab was on, so restarting a session returns you to it.
    if (tab.id !== undefined) await chrome.tabs.update(tab.id, { url: blockedUrl(site, tab.url) })
  }
}

async function runSync() {
  const health = await readHealth()
  let unlocked = null
  let failed = false

  try {
    unlocked = await unlockedDomains()
  } catch {
    // Offline, misconfigured, or Supabase erroring.
    failed = true
  }

  let heldByGrace = false
  if (failed) {
    const grace = graceFailures()
    health.failures = Math.min(health.failures + 1, grace + 1)
    if (health.failures <= grace) {
      // Still inside the grace window: hold what was true at the last good
      // poll, minus anything that has since run out.
      unlocked = stillRunning(health.lastGood)
      heldByGrace = true
    } else {
      // Grace exhausted. Fail closed, and stop trusting the held set.
      unlocked = new Map()
      health.lastGood = {}
    }
  } else if (unlocked === null) {
    // Signed out is a definite answer, not a failed poll. No grace for it.
    unlocked = new Map()
    health.failures = 0
    health.lastGood = {}
  } else {
    health.failures = 0
    health.lastGood = Object.fromEntries(unlocked)
  }

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
    [HEALTH_KEY]: health,
    et_status: {
      checkedAt: Date.now(),
      unlocked: Object.fromEntries(unlocked),
      failures: health.failures,
      heldByGrace,
    },
  })
}

/**
 * Serialised. The alarm, the expiry alarm, the popup and the block page can all
 * ask for a sync at once; two overlapping runs read getDynamicRules() before
 * either has written, and the loser puts back rules the winner just removed —
 * which looks exactly like a block flapping back on. One at a time instead.
 */
let syncChain = Promise.resolve()

export function sync() {
  syncChain = syncChain.then(runSync, runSync)
  return syncChain
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
    // The block page and the popup both use this to force a re-check on demand
    // instead of waiting out the poll interval. The reply carries which domains
    // are unlocked, so the caller knows whether it is safe to navigate back.
    sync().then(
      async () => {
        const { et_status: status } = await chrome.storage.local.get('et_status')
        sendResponse({ ok: true, unlocked: status?.unlocked ?? {} })
      },
      (e) => sendResponse({ ok: false, error: String(e) }),
    )
    return true
  }
  return false
})
