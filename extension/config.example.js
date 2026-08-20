// Copy this file to config.js and fill in the two Supabase values.
// config.js is gitignored, the same way the web app's .env is.
//
// Add a site by adding an entry to `sites` — nothing else needs editing.
// (host_permissions is <all_urls> precisely so adding a site here is enough.)

export const CONFIG = {
  // Project Settings -> API. The anon public key, never service_role.
  supabaseUrl: 'https://your-project-ref.supabase.co',
  supabaseAnonKey: 'your-anon-public-key',

  // Where the "go to the dashboard" links point.
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
