// Spec section 3. Hardcoded on purpose for Phase 1 — these get tuned by hand
// after week 1, so they are not configuration.
export const TIER_MINUTES: Record<Tier, number> = { 1: 20, 2: 12, 3: 5 }
export const TIER_LABELS: Record<Tier, string> = {
  1: 'Tier 1 — big, hard, most important',
  2: 'Tier 2 — medium',
  3: 'Tier 3 — small chores',
}

/** Daily cap on *earned* minutes, so small tasks cannot be ground into infinite Clash Royale. */
export const DAILY_CAP_MINUTES = 60

export const TRACKED_APPS = ['Snapchat', 'Instagram', 'YouTube', 'Clash Royale', 'Brawl Stars']

/**
 * Session lengths (spec section 3), mirrored by SESSION_LENGTHS in
 * extension/blocked.js. Since spec section 3A these are offered at the block
 * page rather than in the app — the app shows them, it does not start them.
 */
export const SESSION_LENGTHS = [5, 10, 15, 20]

/**
 * Spec section 3B. Never blocked, never tracked — in any window, in any phase,
 * on any platform. Mirrored by extension/always-allowed.js.
 *
 * Blocking in this project is opt-in per app and per site: something is blocked
 * because it was added to TRACKED_APPS or to `sites` in extension/config.js.
 * This is the one list that cannot be opted in. A schedule that can strand you
 * without a way to call home is a schedule that gets uninstalled.
 */
export const ALWAYS_ALLOWED = [
  'Phone',
  'FaceTime',
  'Messages',
  'Lyft',
  'Waymo',
  'DoorDash',
] as const

const ALWAYS_ALLOWED_LOWER = new Set<string>(ALWAYS_ALLOWED.map((a) => a.toLowerCase()))

export function isAlwaysAllowed(appName: string): boolean {
  return ALWAYS_ALLOWED_LOWER.has(appName.trim().toLowerCase())
}

export type Tier = 1 | 2 | 3
