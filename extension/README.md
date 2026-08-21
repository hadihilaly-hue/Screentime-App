# EarnedTime Blocker (Chrome, Manifest V3)

Blocks the tracked sites on the EarnedTime schedule, and unlocks one when you
spend minutes on it. It uses the same Supabase project as the web app.

Since v0.4.0 this is also where sessions **start** (spec section 3A). The block
page is the only place in the product that can create one, so the extension is
no longer read-only — it writes the same two tables the app already writes
(`sessions`, `balances`) under the same RLS policies.

## The schedule (spec section 3A)

Everything below is local device time.

| Window | Hours | What the extension does |
| --- | --- | --- |
| Open | 7:00am – 9:00am | No rules at all. Supabase is not even consulted |
| Hard block | 9:00am – 6:00pm | Everything blocked. A running session unlocks nothing |
| Spend window | 6:00pm – 12:00am | Blocked until you spend minutes at the block page |
| Hard cutoff | 12:00am – 7:00am | Everything blocked, same as the hard block |

The clock decides before the `sessions` table does. That ordering is the whole
point: there is no row you can write, and no session you can leave open, that
opens a tracked site at 2pm. Unlocks are capped at the end of the window too, so
a 20-minute session started at 11:55pm ends at midnight with the balance.

Boundaries fire on an alarm rather than on the one-minute poll, so 9:00am blocks
at 9:00am and sweeps the tabs that were open. The sweep is best-effort per tab:
one the browser will not redirect is reported and retried on the next check
rather than silently skipped — see the eviction bullet under **How it works**.

## Always allowed (spec section 3B)

**Phone, FaceTime, Messages, Lyft, Waymo, DoorDash** are never blocked and never
tracked, in any window. `always-allowed.js` filters them out of `sites` before a
single rule is built, so adding `doordash.com` to `config.js` does nothing at
all. Blocking here is opt-in per site; this is the one list that cannot be
opted in.

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

   Set `dashboardUrl` to wherever you run the app —
   `http://localhost:5173/dashboard` during development,
   `https://your-project.vercel.app/dashboard` once it is deployed. It is only
   used for the "go to the dashboard" links on the block page and in the popup.

2. **Load it in Chrome.**
   - Go to `chrome://extensions`
   - Turn on **Developer mode** (top right)
   - **Load unpacked** → select this `extension/` folder

3. **Let the app reach it (optional, but it is the difference between a
   two-second re-block and a one-minute one).** This takes two settings, one on
   each side, and **both** are required — either one alone does nothing.

   **a. The extension's id, in the app.** Copy it from the extension's card on
   `chrome://extensions` and put it in the web app's `.env`:

   ```
   VITE_EXTENSION_ID=the-long-lowercase-id
   ```

   Then restart the dev server, or redeploy — Vite inlines env vars at build
   time, so on Vercel this is an environment variable plus a fresh deployment,
   not a runtime setting.

   **b. The app's origin, in the extension.** `manifest.json` lists the origins
   allowed to send the hint under `externally_connectable.matches`. It ships
   with three:

   ```json
   "externally_connectable": {
     "matches": [
       "http://localhost/*",
       "http://127.0.0.1/*",
       "https://replace-with-your-vercel-domain.example.invalid/*"
     ]
   },
   ```

   The first two are **http**, because they are the Vite dev server. The third
   is a placeholder for your deployed app — **replace that whole line** with
   your real origin, keeping the `https` and the trailing `/*`:

   ```json
   "https://earnedtime.vercel.app/*"
   ```

   **Why the placeholder is there rather than an instruction to add a line:**
   a deployed app is https, and `https://host/*` does not match
   `http://host/*` — different scheme, no match — so a hosted app genuinely
   needs its own entry, and an array with an obvious gap in it is harder to
   overlook than a paragraph in a README. Leaving it as shipped grants nothing:
   `.invalid` is a reserved TLD (RFC 2606) that can never be registered, so
   there is no origin in the world that matches it.

   `manifest.json` is strict JSON with no comments, so any editor, `jq` or CI
   JSON check reads it. That is why this explanation lives here.

   After editing, hit **Reload** on the extension card. Without the reload
   Chrome is still running the old manifest and the origin is not allowed yet —
   the manifest is read at load time, not per message.

   **Skip either half and nothing breaks — it just gets slower.** No
   `VITE_EXTENSION_ID`, an origin not listed in `externally_connectable`, a
   browser with no extensions, or no extension at all: the hint is never
   delivered, the app shows no error, and ending a session early re-blocks on
   the worker's own one-minute poll (`pollMinutes`) instead of in about a
   second. The block always comes back; this only decides how fast.

   Two ways to tell it is actually working, on the deployed URL: end a session
   early and watch a tab on a tracked site get evicted in a second or two rather
   than up to a minute; or open the app's page, look at the DevTools console,
   and confirm no "Could not establish connection" error appears — the app
   swallows that one, but its absence together with a fast re-block is the
   signal that the message landed.

4. **Sign in.** Click the extension icon and enter the same email and password
   as the web app. There is no signup here. The session is stored in extension
   storage and refreshed automatically, so this is a one-time step.

After any edit to `config.js` or `manifest.json`, hit **Reload** on the
extension card. Reloading changes the extension's id only if you loaded it from
a different folder — otherwise `VITE_EXTENSION_ID` stays valid.

## Confirming you are running the latest code

Chrome does not pick up a `git pull` on its own — the extension keeps running
the code it loaded until you press **Reload** on its card in
`chrome://extensions`.

The block page shows the version it is running at the bottom
(`EarnedTime Blocker v0.4.0`). If that line is missing, or shows an older
number than the `version` in `manifest.json`, the browser is on stale code —
hit Reload and open a blocked site again.

From v0.4.0 the block page should visibly have all of:

- the current window as its first line (`Spend window · closes 12:00 AM`,
  `Hard block`, `Hard cutoff`, `Open · until 9:00 AM`)
- in the spend window: your balance, and **5 / 10 / 15 / 20** buttons, greyed
  out below what you can afford. Tapping one starts the session and lets you
  through — there is no separate "start" step
- in every other window: no buttons at all, and a `Locked until 6:00 PM`
  (or `7:00 AM`) slab. The balance is labelled *spendable at 6:00 PM*
- one quote, picked at random per page load
- the URL you were heading to
- a **Check again** button
- a diagnostics line naming the window, whether you are signed in, how many
  unfinished session rows the query returned, how many are still running,
  whether any matches this site, and when the worker last checked
- a separate error line above it, empty unless something actually failed
- the version line

## Starting a session

In the spend window, one tap on a length does all of this in order: check the
balance, deduct the minutes, insert the session row, have the worker drop the
rules, and navigate to the URL you originally asked for.

Only one step of that order is forced: the worker will not unlock a domain until
a session row exists, so the insert has to come before the rules drop. Deducting
*before* the insert is a choice, not a necessity — it is what stops a reload
mid-start buying the same minutes twice — and the price of that choice is a
window where the minutes are gone and the next step fails.

**The policy in that window leans one way on purpose: it prefers overcharging
you to opening the site for free.** A lean, not a law — see **Known holes**
below.

- **The insert is rejected** → the minutes are refunded. Nothing exists yet, so
  the undo is a single write. (The refund is a compare-and-swap and can itself
  be refused if the balance moved; the page says so rather than pretending.)

  "Rejected" is inferred from the call throwing, and an insert that commits
  server-side but whose response is lost throws too — so a refund is attempted
  while the session row survives, and if that refund lands the worker will still
  honour the row. See **Known holes** below.
- **The release is definitively refused** → **the minutes stay spent.** Two
  things count as definitive, and both cost the minutes:
  - the browser rejecting the rules write, so the old rules survive; and
  - the worker's own decision leaving the domain blocked while it *could* read
    the sessions table — most often an `app_name` in `sites` that matches no
    session. That one is a configuration fault rather than a browser one, but
    the outcome is identical (paid, still outside), so the policy is identical
    rather than a quiet exception.

  Instead of a refund, closing the session row is **attempted** — up to five
  times with backoff (500ms doubling to 4s) — to stop the tap unlocking the site
  on a later check, once whatever refused it clears (a rules write that lands
  next time, or a corrected `app_name`). An attempt, not a guarantee: if all five fail,
  or the row cannot be confirmed closed, the block page says so, and the session
  may still unlock the site before it expires on its own. What it does not do is
  claim a close it could not verify.

Losing minutes this way is rare, visible, and recoverable by finishing another
task. A free unlock is none of those, and it is what the schedule exists to
prevent. Two earlier attempts to refund this case produced, in order, a free
unlock and a retry loop that reported the wrong cause — so the refund is gone
rather than repaired.

### Known holes

Listed rather than argued around. This is what is known to be open today, not a
proof that nothing else is.

1. **Lost insert response.** A session insert that commits server-side but whose
   response never arrives is indistinguishable here from one that was rejected,
   so a refund is attempted against a session that exists. If that refund lands
   (it is a compare-and-swap and can be refused), the minutes are back and the
   worker will honour the row. Closing it properly needs the debit and the
   insert in one transaction, which is a schema change and out of scope for
   Phase 1. `extension/spend.js` documents it at the catch that causes it.

A check that simply did not finish, or a decision the worker is holding through
its grace window, changes nothing at all: the session stands and the page keeps
trying. Neither says the rules failed, and treating them as if they did
cancelled sessions that were about to work.

Outside the spend window there is nothing to tap. `startSession` refuses on the
clock as well, so even a page left open from 5:55pm cannot be clicked into a
session at 5:59.

## Quotes

`quotes.js` holds ~66 short quotes on discipline, focus and delayed
gratification; the block page picks one at random per load and does not rotate
it while you are looking at it. Attributions are real — several widely shared
"Aristotle" and "Confucius" lines are misattributions and are deliberately
absent, and anything genuinely of unknown origin is marked Anonymous rather than
pinned on whoever the internet says. Keep that rule when adding to it.

## Reading the diagnostics line

It is one line under the dashboard link, and it is meant to make a failure
obvious rather than silent:

- `Locked until 6:00 PM` as the first item — you are outside the spend window
  and no session can exist. This is the schedule, not a failure.
- `NOT signed in` — open the extension icon and sign in.
- `0 unfinished session row(s)` — the session never got written. Check the web
  app's dashboard: did the timer actually start?
- `2 still running: Snapchat 4m` but `none match youtube.com` — a session is
  live for a different app than the site you are on.
- `MATCHES youtube.com` and still blocked — the worker did not drop the rules.
  The line will say so; reload the extension.
- `Could not reach Supabase: …` — network or config problem, verbatim.
- `LAST RULES WRITE FAILED: …` — the browser refused the rule write, so the
  previous rules are still in force and the worker's decision and what is
  actually enforced have come apart.
- `tabs not evicted — …` — a tab on a blocked site would not redirect. It is
  retried every check; if it persists, the tab is still on a site that should
  be walled.
- `N failed check(s), holding last known state` — the worker cannot reach
  Supabase and is inside its grace window; the block has not come back yet.
- `N failed check(s), blocking until one succeeds` — grace is used up and it has
  failed closed.

Failures print on their own line above the diagnostics, so the routine status
refresh a few seconds later cannot overwrite the message worth reading.

## How it works

- **The window is checked first** (`schedule.js`). Outside 6:00pm–midnight the
  sessions query is not made at all: 7:00am–9:00am removes every rule,
  everything else installs every rule. An alarm is set for the next boundary as
  well as for the next session expiry, whichever is sooner.
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
- **Every sync sweeps the tabs**, not just the one that re-applies a rule: any
  tab sitting on a blocked domain is sent to the block page, every poll, for
  every reason the site is blocked (expiry, an early end, a window boundary,
  signing out). It was transition-detected before, and that missed the case
  that matters — a redirect rule only sees network requests, so reloading a
  site with a service worker can be answered from its cache and never trips it.
  Ending a session early re-blocked the rule while the tab you were already on
  carried on working. Each tab's redirect is guarded on its own, so a tab that
  refuses to be updated — a tab closed between the query and the update rejects
  with "No tab with id", which is ordinary with several tabs on one site — is
  logged and retried on the next poll without shielding the tabs behind it, and
  reported in `et_status` so a tab that will not move is visible in the popup
  and on the block page rather than only in the console.
- A rules write that the browser rejects no longer skips the sweep, the expiry
  alarm and the status write. It is recorded, the sweep runs anyway (it is the
  safer half of the pair), and the block page's diagnostics say
  `LAST RULES WRITE FAILED`, so the symptom is not just sites quietly not
  blocking.
- **Ending a session early re-blocks in about a second**, not on the next poll.
  The app sends a `sync-hint` message to the extension id it was configured
  with, and the worker runs the same sync the alarm runs. The hint is a hint:
  it carries no state, the worker still re-reads Supabase and decides for
  itself, and the reply says only whether the sync ran. A forged message can
  therefore make the extension check sooner and nothing else — there is no path
  from this message to an unlock. Without the id, or from an origin not listed
  in `externally_connectable`, the message goes nowhere and the poll does the
  work.
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
(`src/lib/constants.ts`) for a session to ever exist for it. The block page
starts sessions under `apps[0]`.

Anything matching the always-allowed list is dropped, whatever you write here.

The schedule in `schedule.js` is deliberately not configurable — the point of a
schedule you cannot edit at 2pm is that you cannot edit it at 2pm. It is
mirrored by `src/lib/schedule.ts` in the web app; the two files must agree, and
are duplicated only because this extension has no build step.

Nothing else needs editing — `host_permissions` is `<all_urls>` so that adding
a site here is the only step.

## Limits

- Chrome only (Manifest V3). No Firefox/Safari build.
- A session started elsewhere takes up to 5 seconds to release an open block
  page, or up to a minute for a tab that is not on one. **Re-check now** in the
  popup, or **Check again** on the block page, skips the wait. A session started
  on the block page itself does not wait at all.
- The balance check when starting a session is read-then-write, like the web
  app's. Two block pages tapped in the same second could both pass it.
- The clock comes from your machine, same as the web app.
- The app's re-check hint is best-effort. No `VITE_EXTENSION_ID`, an origin not
  in `externally_connectable`, a different browser, or no extension at all all
  fall back to the poll, silently — the app never shows an error for it.
