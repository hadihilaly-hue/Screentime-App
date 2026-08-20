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
export const SESSION_LENGTHS = [5, 10, 15, 20]

export type Tier = 1 | 2 | 3
