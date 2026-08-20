// Spec section 3B. Never blocked, never tracked — in any window, in any phase,
// on any platform.
//
// Mirrored by ALWAYS_ALLOWED in src/lib/constants.ts. Blocking in this project
// is opt-in per app and per site; this is the one list that cannot be opted in.

export const ALWAYS_ALLOWED = [
  { name: 'Phone', domains: [] },
  { name: 'FaceTime', domains: ['facetime.apple.com'] },
  { name: 'Messages', domains: ['messages.google.com', 'messages.apple.com'] },
  { name: 'Lyft', domains: ['lyft.com'] },
  { name: 'Waymo', domains: ['waymo.com'] },
  { name: 'DoorDash', domains: ['doordash.com'] },
]

const NAMES = new Set(ALWAYS_ALLOWED.map((a) => a.name.toLowerCase()))
const DOMAINS = new Set(ALWAYS_ALLOWED.flatMap((a) => a.domains).map((d) => d.toLowerCase()))

function domainAllowed(domain) {
  const host = String(domain ?? '').toLowerCase()
  for (const allowed of DOMAINS) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return true
  }
  return false
}

/**
 * Whether a configured site is one of the six.
 *
 * Matched on the domain *and* on every app_name it claims to unlock, so neither
 * a typo'd domain nor an entry labelled "Lyft" can end up with a blocking rule.
 */
export function isAlwaysAllowed(site) {
  if (!site) return false
  if (domainAllowed(site.domain)) return true
  return (site.apps ?? []).some((app) => NAMES.has(String(app).toLowerCase()))
}

/**
 * config.js, minus anything on the list.
 *
 * Called once at the top of every sync, before a single rule is built: the
 * enforcement is that the always-allowed sites never reach the rule builder,
 * not that some later branch remembers to skip them.
 */
export function blockableSites(sites) {
  return (sites ?? []).filter((site) => !isAlwaysAllowed(site))
}
