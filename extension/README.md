# EarnedTime Blocker (Chrome, Manifest V3)

Blocks the tracked sites unless a session for them is running in EarnedTime.
It reads the same Supabase project as the web app and writes nothing.

This layer is **friction, not a vault**. It is trivially disabled from
`chrome://extensions`, and that is on purpose — Phase 1 measures whether the
economy changes your behaviour (spec section 7), it does not try to imprison
you.

## Setup

1. **Configure it.** From this directory:

   ```sh
   cp config.example.js config.js
   ```

   Fill in `supabaseUrl` and `supabaseAnonKey` — the same two values as the web
   app's `.env`, from Project Settings → API. Use the **anon public** key.
   `config.js` is gitignored, like `.env`.

   Set `dashboardUrl` to wherever you run the app (`http://localhost:5173/dashboard`
   during development, your deployed URL once it is hosted).

2. **Load it in Chrome.**
   - Go to `chrome://extensions`
   - Turn on **Developer mode** (top right)
   - **Load unpacked** → select this `extension/` folder

3. **Sign in.** Click the extension icon and enter the same email and password
   as the web app. There is no signup here. The session is stored in extension
   storage and refreshed automatically, so this is a one-time step.

After any edit to `config.js`, hit **Reload** on the extension card.

## Confirming you are running the latest code

Chrome does not pick up a `git pull` on its own — the extension keeps running
the code it loaded until you press **Reload** on its card in
`chrome://extensions`.

The block page shows the version it is running at the bottom
(`EarnedTime Blocker v0.3.0`). If that line is missing, or shows an older
number than the `version` in `manifest.json`, the browser is on stale code —
hit Reload and open a blocked site again.

From v0.3.0 the block page should visibly have all of:

- a **I started a session — let me through** button
- the URL you were heading to, printed under the balance
- a diagnostics line naming whether you are signed in, how many unfinished
  session rows the query returned, how many are still running, whether any
  matches this site, and when the worker last checked
- a separate error line above it, empty unless something actually failed
- the version line

## Reading the diagnostics line

It is one line under the dashboard link, and it is meant to make a failure
obvious rather than silent:

- `NOT signed in` — open the extension icon and sign in.
- `0 unfinished session row(s)` — the session never got written. Check the web
  app's dashboard: did the timer actually start?
- `2 still running: Snapchat 4m` but `none match youtube.com` — a session is
  live for a different app than the site you are on.
- `MATCHES youtube.com` and still blocked — the worker did not drop the rules.
  The line will say so; reload the extension.
- `Could not reach Supabase: …` — network or config problem, verbatim.
- `N failed check(s), holding last known state` — the worker cannot reach
  Supabase and is inside its grace window; the block has not come back yet.
- `N failed check(s), blocking until one succeeds` — grace is used up and it has
  failed closed.

Failures print on their own line above the diagnostics, so the routine status
refresh a few seconds later cannot overwrite the message worth reading.

## How it works

- Blocking is `declarativeNetRequest` redirect rules — one per site, plus one
  extra for YouTube that catches iframes **only when the parent page is
  youtube.com itself**, so a YouTube embed on someone else's blog still plays.
- Subdomains are covered (`requestDomains` matches the domain and everything
  under it).
- Every minute, and again shortly after a running session ends, the extension
  asks Supabase for sessions with `ended_at` null whose `started_at + minutes`
  is still in the future. The exact query is
  `sessions?select=app_name,minutes,started_at&ended_at=is.null` — deliberately
  **not** filtered by date. `sessions.date` is written from the user's local
  date while Postgres `current_date` is UTC, and those disagree every evening
  west of Greenwich, so a date filter would return nothing all evening. Sites with such a session have their rules removed;
  everything else stays blocked.
- The block page does not wait for that poll. On load, and every 5 seconds
  while it is open, it checks Supabase itself for a session covering this site.
  If it finds one it has the worker drop the rules first, then sends you on to
  the URL you originally asked for — so starting a session in the app releases
  a block page that is already open, without touching it. Once it has released
  you it stops checking, and while the tab is hidden it drops to once a minute.
- The URL you were heading to rides along in the block page's fragment, so an
  unlock returns you to that exact page rather than the site's front door. It is
  only honoured when it is `http(s)` **on the blocked site itself** (or a
  subdomain). `blocked.html` is web-accessible, so without that check a crafted
  `blocked.html#from=…` would make the extension navigate anywhere on request.
- The popup's **Re-check now** forces the same immediate re-check. Syncs are
  serialised, so the popup, the block page and the alarm cannot interleave two
  rule rewrites and leave the loser's rules behind.
- When a site goes back to blocked, tabs already sitting on it are redirected
  too — you do not have to reload for the block to come back.
- **It fails closed, after a grace window.** Signed out is immediate: everything
  blocks. A failed *check* — offline, or Supabase erroring — is tolerated for
  `graceFailures` consecutive polls (default 3, set it to 0 for the old
  block-on-first-error behaviour), during which the last known-good unlock is
  held. That held state is still expiry-checked, so grace only ever covers "I
  cannot reach Supabase", never "your session ended". Without it a single
  dropped packet mid-session bounced you to the block page and the next poll let
  you straight back in.
- If a release is immediately followed by landing back on the block page, the
  page stops auto-navigating and waits for the button, rather than ping-ponging
  with the worker.

## Adding a site

Add an entry to `sites` in `config.js` and reload the extension:

```js
{ domain: 'reddit.com', label: 'Reddit', apps: ['Reddit'] }
```

`apps` lists the `app_name` values in the `sessions` table that unlock the
domain, so it should match an entry in the web app's `TRACKED_APPS`
(`src/lib/constants.ts`) for a session to ever exist for it.

Nothing else needs editing — `host_permissions` is `<all_urls>` so that adding
a site here is the only step.

## Limits

- Chrome only (Manifest V3). No Firefox/Safari build.
- A session started elsewhere takes up to 5 seconds to release an open block
  page, or up to a minute for a tab that is not on one. **Re-check now** in the
  popup, or the button on the block page, skips the wait.
- The clock comes from your machine, same as the web app.
