// Applies and lifts the blocks.
//
// Blocking is declarativeNetRequest redirect rules, one (or two) per configured
// site. Two things decide whether a site's rules are present, in this order:
//
//   1. The schedule (spec section 3A). Outside 6:00pm-12:00am the sessions
//      table is not even consulted — 7:00am-9:00am is open, everything else is
//      a hard block. This is what makes the daytime a wall rather than a
//      suggestion: no row in any table unlocks a tracked site at 2pm.
//   2. Inside the spend window, a running session in the sessions table, as
//      before. Its unlock is capped at the end of the window, so a session
//      started at 11:55pm still ends at midnight.
//
// Sites on the always-allowed list (spec section 3B) never reach the rule
// builder at all, in any window.

import { CONFIG } from './config.js'
import { query } from './supabase.js'
import { phaseAt } from './schedule.js'
import { blockableSites } from './always-allowed.js'

const RULE_BASE = 1000
const POLL_ALARM = 'et-poll'
const EXPIRY_ALARM = 'et-expiry'
const HEALTH_KEY = 'et_health'

/**
 * The sites rules may be written for: config, minus the always-allowed six.
 *
 * Rule ids are derived from this list's indices, and it is derived from a
 * constant config, so the ids are stable across runs the same way they were.
 */
function sites() {
  return blockableSites(CONFIG.sites)
}

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
async function unlockedDomains(windowEndsAt) {
  const rows = await query('sessions?select=app_name,minutes,started_at&ended_at=is.null')
  if (rows === null) return null

  const now = Date.now()
  const unlocked = new Map()
  for (const row of rows) {
    // Capped at the end of the spend window: minutes expire at midnight
    // (spec section 3), so a session cannot carry an unlock past it.
    const endsAt = Math.min(new Date(row.started_at).getTime() + row.minutes * 60_000, windowEndsAt)
    if (endsAt <= now) continue
    const site = sites().find((s) => s.apps.includes(row.app_name))
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
  const site = sites().find((s) => s.domain === domain)
  for (const tab of tabs) {
    // Carry the URL the tab was on, so restarting a session returns you to it.
    if (tab.id !== undefined) await chrome.tabs.update(tab.id, { url: blockedUrl(site, tab.url) })
  }
}

/**
 * Send every tab sitting on a blocked domain to the block page.
 *
 * The single eviction path, run on every sync against every domain that is
 * blocked right now — deliberately not only on the sync that first re-applies
 * the rules. Transition detection was the bug: end a session early and the
 * rules came back, but the tab you were already on kept working. Any of these
 * defeated it, and all of them are ordinary:
 *
 *   * A redirect rule only sees network requests. Reloading a site with a
 *     service worker (Snapchat has one) can be answered from its cache without
 *     one, so the rule never fires and the page stays usable.
 *   * A transition observed in a sync that ran with no tab open, or missed
 *     because the rules were already back, never came round again.
 *   * One rejected chrome.tabs.update threw out of the loop and took the rest
 *     of the sync's evictions with it.
 *
 * Blocked means no tab may sit on it, so that is what this asserts, every time,
 * for every reason a site becomes blocked: expiry, an early end noticed by the
 * poll or the alarm, a window boundary at 9:00am or midnight, or signing out.
 * It costs one tabs.query per blocked site per poll and normally finds nothing,
 * because an evicted tab is on the block page and no longer matches.
 */
async function evictBlockedTabs(domains) {
  for (const domain of domains) {
    try {
      await evictOpenTabs(domain)
    } catch (e) {
      // One tab refusing to be updated must not cost the other sites their
      // eviction, nor the rest of this sync its alarm and status write.
      console.warn(`EarnedTime: could not evict tabs on ${domain}`, e)
    }
  }
}

async function runSync() {
  const blockable = sites()
  const phase = phaseAt()
  const health = await readHealth()
  let unlocked = null
  let failed = false
  let heldByGrace = false

  if (phase.kind === 'open') {
    // 7:00am-9:00am. Nothing is blocked and nothing is metered, so the sessions
    // table is irrelevant — every site is unlocked until the window ends.
    unlocked = new Map(blockable.map((site) => [site.domain, phase.endsAt]))
    health.failures = 0
    health.lastGood = {}
  } else if (phase.kind !== 'spend') {
    // Hard block or hard cutoff. The schedule alone decides, so there is
    // nothing to ask Supabase and nothing a failed poll could change. Grace
    // does not apply: this is not a failure to answer, it is the answer.
    unlocked = new Map()
    health.failures = 0
    health.lastGood = {}
  } else {
    try {
      unlocked = await unlockedDomains(phase.endsAt)
    } catch {
      // Offline, misconfigured, or Supabase erroring.
      failed = true
    }

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
  }

  const allIds = CONFIG.sites.flatMap((_, i) => ruleIds(i))
  const addRules = blockable.flatMap((site, i) =>
    unlocked.has(site.domain) ? [] : rulesFor(site, i),
  )

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: allIds, addRules })

  // Rules first, then tabs: a tab evicted before the rules were back could
  // navigate straight to the site again. Every blocked domain is checked, not
  // just the ones that changed this pass — see evictBlockedTabs.
  await evictBlockedTabs(
    blockable.filter((site) => !unlocked.has(site.domain)).map((site) => site.domain),
  )

  // Re-check exactly when the earliest running session ends, or when the window
  // changes, whichever comes first. Without the boundary the 9:00am block would
  // land up to a poll late, and an open tab would keep going until it did.
  const nextEnd = Math.min(...[...unlocked.values()], phase.endsAt)
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
      phase: phase.kind,
      phaseEndsAt: phase.endsAt,
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
