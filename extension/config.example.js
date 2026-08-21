// Copy this file to config.js and fill in the two Supabase values.
// config.js is gitignored, the same way the web app's .env is.
//
// Add a site by adding an entry to `sites` — nothing else needs editing.
// (host_permissions is <all_urls> precisely so adding a site here is enough.)
//
// Three things here are NOT configurable, on purpose:
//
//   * The schedule (spec section 3A) lives in schedule.js — 7-9am open,
//     9am-6pm hard block, 6pm-midnight spend window, midnight-7am hard cutoff.
//     The point of a schedule you cannot edit at 2pm is that you cannot edit it
//     at 2pm.
//   * The origins allowed to send the re-check hint live in manifest.json
//     under externally_connectable. The entries shipped there are http, because
//     they are the dev server; a deployed app is https and http://host/* does
//     not match it. The third entry there is a placeholder on an unregistrable
//     .invalid domain — swap that whole line for your deployed origin (e.g.
//     "https://earnedtime.vercel.app/*") and hit Reload on the extension card,
//     or ending a session early will re-block on
//     the one-minute poll instead of in a couple of seconds. Match patterns
//     ignore ports, so one localhost entry covers 5173, 5174 and anything else.
//   * The always-allowed list (spec section 3B) lives in always-allowed.js —
//     Phone, FaceTime, Messages, Lyft, Waymo, DoorDash. Anything in `sites`
//     that matches it is dropped before a rule is ever written, so adding
//     doordash.com below does nothing at all.

export const CONFIG = {
  // Project Settings -> API. The anon public key, never service_role.
  supabaseUrl: 'https://your-project-ref.supabase.co',
  supabaseAnonKey: 'your-anon-public-key',

  // Where the "go to the dashboard" links point, from the block page and the
  // popup. Point it at wherever the app actually runs for you:
  //
  //   * during development:  'http://localhost:5173/dashboard'
  //   * once deployed:       'https://earnedtime.vercel.app/dashboard'
  //
  // Keep the /dashboard path — the app's morning gate will bounce you back to
  // "/" on its own if today's list is not confirmed yet, so linking straight to
  // the dashboard is right in both states. No trailing slash.
  //
  // This is separate from externally_connectable above and does not affect the
  // re-check hint: getting one right does not configure the other.
  dashboardUrl: 'http://localhost:5173/dashboard',

  // How often to re-check Supabase for a running session, in minutes.
  // Chrome clamps alarms below 0.5. An exact alarm is also set for the moment
  // a running session ends, so this is only the safety net.
  pollMinutes: 1,

  // Consecutive failed checks tolerated before a running session is re-blocked.
  // Below this, the last known-good unlock is held (still expiry-checked), so a
  // brief network drop no longer bounces you out mid-session and back in again.
  // 0 means fail closed on the first error.
  graceFailures: 3,

  sites: [
    {
      domain: 'snapchat.com',
      label: 'Snapchat',
      // app_name values in the sessions table that unlock this domain.
      apps: ['Snapchat'],
    },
    {
      domain: 'instagram.com',
      label: 'Instagram',
      apps: ['Instagram'],
    },
    {
      domain: 'youtube.com',
      label: 'YouTube',
      apps: ['YouTube'],
      // Also block youtube iframes, but only those embedded on youtube.com
      // itself. A YouTube embed on any other site is left alone.
      blockEmbedsOnSelf: true,
    },
  ],
}
