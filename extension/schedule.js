// The four daily windows (spec section 3A), on the local device clock.
//
// Mirrored by src/lib/schedule.ts in the web app. The two files must agree —
// they are duplicated rather than shared because the extension has no build
// step and cannot import TypeScript. Keep any edit in both.

/** Window boundaries as whole local hours, in the order they occur. */
export const CUTOFF_END_HOUR = 7 // 12:00am-7:00am is the hard cutoff
export const OPEN_END_HOUR = 9 // 7:00am-9:00am is open
export const SPEND_START_HOUR = 18 // 9:00am-6:00pm is the hard block
// 6:00pm-12:00am is the spend window, ending at the next midnight.

/**
 * Phase kinds:
 *   'open'    no blocking, no rules, nothing metered
 *   'blocked' hard block, 9:00am-6:00pm
 *   'spend'   blocked by default, unlockable by starting a session
 *   'cutoff'  hard block, 12:00am-7:00am
 */

function at(now, hour) {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/** Local midnight at the *end* of the day `now` falls in. */
function nextMidnight(now) {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/**
 * The window containing `now`, with the exact instant it ends.
 *
 * endsAt is a real timestamp rather than an hour so that callers can set an
 * alarm on it directly — a boundary that fires at 9:00:00 rather than whenever
 * the next poll happens to land is the difference between a wall and a delay.
 */
export function phaseAt(now = Date.now()) {
  const hour = new Date(now).getHours()

  if (hour < CUTOFF_END_HOUR) {
    return { kind: 'cutoff', endsAt: at(now, CUTOFF_END_HOUR) }
  }
  if (hour < OPEN_END_HOUR) {
    return { kind: 'open', endsAt: at(now, OPEN_END_HOUR) }
  }
  if (hour < SPEND_START_HOUR) {
    return { kind: 'blocked', endsAt: at(now, SPEND_START_HOUR) }
  }
  return { kind: 'spend', endsAt: nextMidnight(now) }
}

/** True only inside 6:00pm-12:00am — the one window a session can exist in. */
export function canSpend(now = Date.now()) {
  return phaseAt(now).kind === 'spend'
}

/** When the spend window next opens: today at 6pm, or tomorrow's if it has passed. */
export function spendOpensAt(now = Date.now()) {
  const phase = phaseAt(now)
  if (phase.kind === 'spend') return at(now, SPEND_START_HOUR)
  const todaySix = at(now, SPEND_START_HOUR)
  return todaySix > now ? todaySix : at(now + 24 * 3_600_000, SPEND_START_HOUR)
}

/** "6:00 PM" in the device's own formatting, for the locked-until line. */
export function clockLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const NAMES = {
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
export function phaseSummary(now = Date.now()) {
  const phase = phaseAt(now)
  const name = NAMES[phase.kind]
  if (phase.kind === 'spend') return `${name} · closes ${clockLabel(phase.endsAt)}`
  if (phase.kind === 'open') return `${name} · until ${clockLabel(phase.endsAt)}`
  return `${name} until ${clockLabel(phase.endsAt)}`
}
