# EarnedTime

Turns a daily to-do list into currency for screen time. Phase 1 tests whether
the loop changes behaviour on the honour system, before any iOS blocking is
built. Full spec in [`phase-1-spec.md`](phase-1-spec.md).

## Setup

1. **Create a Supabase project**, then run `supabase/schema.sql` in the SQL
   editor. That is the whole schema — four tables, indexes, RLS policies and
   every guard.

   The `supabase/migration-*.sql` files exist only for a database created
   before a given change. Each one is already folded into `schema.sql`, so on
   a fresh project you skip all of them; on an existing one, run the ones newer
   than your database, in numeric order. All are idempotent.

2. **Create your user** under Authentication → Users → Add user (email +
   password, confirmed). There is no signup flow; this app has one account.

3. **Configure the app:**

   ```sh
   cp .env.example .env      # then fill in both values
   npm install
   npm run dev
   ```

   Both values come from Project Settings → API. Use the **anon public** key —
   never `service_role`, which would be readable by anyone with the bundle.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck then production build into `dist/` |
| `npm run preview` | Serve the built bundle locally |

## Deploying

Any static host works. The build output is `dist/`, and the app uses client-side
routing, so every path must fall back to `index.html`:

- **Vercel** — `vercel.json` already has the rewrite. Set `VITE_SUPABASE_URL`
  and `VITE_SUPABASE_ANON_KEY` in Project Settings → Environment Variables.
- **Netlify** — `public/_redirects` already has the rule. Build command
  `npm run build`, publish directory `dist`.

Vite inlines env vars at build time, so **set them before the build and
redeploy after changing them**. A production build missing either one throws on
load and shows a failure message rather than an app with no auth gate.

## Using it

- **iPhone:** open the deployed URL in Safari → Share → Add to Home Screen. It
  installs as a standalone PWA.
- **Laptop:** set the deployed URL as your browser homepage.

Phase 1 is honour-system **on the phone**: the timer runs, but nothing stops
you opening Snapchat anyway. On the **laptop** it is not — the Chrome
extension in `extension/` redirects the tracked sites to a block page. See
`extension/README.md`.

### The day (spec section 3A)

Local device time, everywhere:

| 7–9am | 9am–6pm | 6pm–midnight | midnight–7am |
| --- | --- | --- | --- |
| Open | Hard block | Spend window | Hard cutoff |

**Earning works at every hour. Spending only works after 6pm.** Before then the
dashboard shows the balance in a *spendable at 6:00 PM* state.

Sessions are started at the block page, not in the app: you open a tracked site,
it is blocked, you pick 5/10/15/20 minutes there, and that tap is the session
start. The app still shows the running countdown — it just no longer starts one.

**Phone, FaceTime, Messages, Lyft, Waymo and DoorDash are never blocked or
tracked**, in any window (spec section 3B). Blocking is opt-in per app and per
site; those six are the permanent exclusion.

## Status

Built (Weekend 1, spec section 8):

- Morning gate — type the day's list; routing blocks everything else until it
  is confirmed
- Task review — edit, tier, add, delete before confirming; cancel after
- Dashboard — balance (with its spendable-at-6pm state), tasks grouped by tier,
  mark done, and a read-only explanation of when and where minutes are spent
- Active session — full-screen countdown, time's-up state, session logging
- Midnight reset — client-side, keyed on the local date

Landed after Weekend 1, out of order:

- Chrome extension — real blocking on the laptop
- The section 3A schedule and the section 3B always-allowed list, in both the
  app and the extension
- Sessions start at the block page, with a quote on it

Not built yet (Weekend 2):

- Voice input, Claude task structuring, proof capture, Claude Vision
  verification, full-completion bonus, streak counter, weekly review
