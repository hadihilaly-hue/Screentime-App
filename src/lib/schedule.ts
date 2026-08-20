// The four daily windows (spec section 3A), on the local device clock.
//
// Mirrored by extension/schedule.js. The two files must agree — they are
// duplicated rather than shared because the extension has no build step and
// imports no TypeScript. Keep any edit in both.

export const CUTOFF_END_HOUR = 7 // 12:00am–7:00am is the hard cutoff
export const OPEN_END_HOUR = 9 // 7:00am–9:00am is open
export const SPEND_START_HOUR = 18 // 9:00am–6:00pm is the hard block
// 6:00pm–12:00am is the spend window, ending at the next midnight.

export type PhaseKind = 'open' | 'blocked' | 'spend' | 'cutoff'

export interface Phase {
  kind: PhaseKind
  /** The exact instant this window ends — a timestamp, so it can be counted down to. */
  endsAt: number
}

function at(now: number, hour: number): number {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/** Local midnight at the *end* of the day `now` falls in. */
function nextMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export function phaseAt(now: number = Date.now()): Phase {
  const hour = new Date(now).getHours()
  if (hour < CUTOFF_END_HOUR) return { kind: 'cutoff', endsAt: at(now, CUTOFF_END_HOUR) }
  if (hour < OPEN_END_HOUR) return { kind: 'open', endsAt: at(now, OPEN_END_HOUR) }
  if (hour < SPEND_START_HOUR) return { kind: 'blocked', endsAt: at(now, SPEND_START_HOUR) }
  return { kind: 'spend', endsAt: nextMidnight(now) }
}

/** True only inside 6:00pm–12:00am — the one window a session can exist in. */
export function canSpend(now: number = Date.now()): boolean {
  return phaseAt(now).kind === 'spend'
}

/** When the spend window next opens: today at 6pm, or tomorrow's if it has passed. */
export function spendOpensAt(now: number = Date.now()): number {
  const phase = phaseAt(now)
  if (phase.kind === 'spend') return at(now, SPEND_START_HOUR)
  const todaySix = at(now, SPEND_START_HOUR)
  return todaySix > now ? todaySix : at(now + 24 * 3_600_000, SPEND_START_HOUR)
}

/** "6:00 PM" in the device's own formatting. */
export function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "2h 14m" — how long until `ts`, for the spendable-at-6pm countdown. */
export function untilLabel(ts: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((ts - now) / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export const PHASE_NAME: Record<PhaseKind, string> = {
  open: 'Open',
  blocked: 'Locked',
  spend: 'Spend window',
  cutoff: 'Locked',
}

/**
 * One line describing the current window and when it changes.
 *
 * A locked window always names its own end, not the next spend window: the
 * cutoff ends at 7:00am into the open window, and telling you at 2am that you
 * are locked until 6:00pm would be both wrong and needlessly bleak.
 */
export function phaseSummary(now: number = Date.now()): string {
  const phase = phaseAt(now)
  const name = PHASE_NAME[phase.kind]
  if (phase.kind === 'spend') return `${name} · closes ${clockLabel(phase.endsAt)}`
  if (phase.kind === 'open') return `${name} · until ${clockLabel(phase.endsAt)}`
  return `${name} until ${clockLabel(phase.endsAt)}`
}
