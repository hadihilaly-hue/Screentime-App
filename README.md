# Scrip

*Working title in the spec was "EarnedTime". **Scrip** is private currency issued
in exchange for labour, which is exactly what this is.*

Turns your daily to-do list into currency for screen time. Phase 1 tests whether
the loop changes behaviour on the honour system, before any iOS blocking exists.
Full spec: [`phase-1-spec.md`](./phase-1-spec.md).

The loop: morning gate → structured task list → do the work → photograph the proof
→ Claude verifies it → minutes land in your balance → spend them on a timed
session → midnight wipes the slate.

## Stack

- **Frontend** — React 19 + Vite + Tailwind v4, installable as a PWA
- **Backend** — Supabase (Postgres + RLS, Auth, Storage, Edge Functions)
- **AI** — Anthropic API (`claude-sonnet-4-6` by default), called only from Edge
  Functions
- **Hosting** — Vercel or Netlify (configs for both are in the repo)

**The Anthropic key never touches the browser.** It lives as a Supabase secret and
is read only inside `supabase/functions/`. The only key in the frontend bundle is
the Supabase anon key, which is protected by Row Level Security.

## Setup

### 1. Supabase project

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push                 # applies supabase/migrations/
```

`db push` creates the tables, the RLS policies, the economy functions and the
private `proofs` storage bucket.

In the dashboard, turn **off** email confirmation under Authentication → Providers
→ Email if you want to sign in immediately after creating your account. This is a
one-person app; there is nobody to confirm to.

Once your account exists, turn **off** signups (Authentication → Providers → Email
→ "Allow new users to sign up") and drop `VITE_ALLOW_SIGNUP` from your deploy. The
app is on a public URL; §9 of the spec says it's a tool for one person.

### 2. Edge Functions

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# optional — defaults to claude-sonnet-4-6
supabase secrets set ANTHROPIC_MODEL=claude-sonnet-4-6

supabase functions deploy structure-tasks
supabase functions deploy verify-proof
supabase functions deploy weekly-observation
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into functions automatically — do not set them yourself.

### 3. Frontend

```bash
cp .env.example .env.local     # fill in URL + anon key from Settings → API
npm install
npm run dev
```

The sign-in screen has no "create account" option unless you set
`VITE_ALLOW_SIGNUP=true`. Set it, make your one account, then unset it.

### 4. Deploy

Push to GitHub and import the repo into Vercel or Netlify. Set `VITE_SUPABASE_URL`
and `VITE_SUPABASE_ANON_KEY` as environment variables there. Both platforms'
SPA-rewrite configs are already committed (`vercel.json`, `netlify.toml`,
`public/_redirects`).

Then: open the deployed URL on your phone → Share → **Add to Home Screen**. Set it
as your laptop's homepage.

## Tuning the economy

Week 1 numbers are meant to be wrong. Everything tunable lives in one row:

```sql
update app_config set
  tier1_minutes = 20,
  tier2_minutes = 12,
  tier3_minutes = 5,
  daily_cap_minutes = 60,
  follow_up_rate = 0.25      -- the 1-in-4 random spot check
where user_id = auth.uid();
```

No redeploy needed; the app reads these at load.

## How the rules are actually enforced

Phase 1 is honour-system about *your phone*, not about the ledger. The ledger is
enforced in Postgres:

| Rule | Where it lives |
| --- | --- |
| Minutes can only be created by a verified proof | `credit_verified_task`, service-role only — the client is denied `EXECUTE` |
| Daily cap of 60 earned minutes | `_credit_task`, applied inside the same transaction that verifies |
| No double credit for one task | `_credit_task` raises if the task is already verified |
| No banking overnight | `balances` is keyed by date, and no task can be created, credited or spent on a date that isn't today |
| A rolled-forward device clock does nothing | `user_today()` derives the date from `now()` and your stored IANA timezone; the client's date is checked against it, never trusted |
| One session at a time, no overspend, 5/10/15/20 only | `start_session` locks the balance row |
| Tasks can't be deleted after confirming | RLS `delete` policy checks `daily_state.list_confirmed` |
| You can't self-declare a task verified, or un-flag a late addition | column-level `GRANT UPDATE (title, tier, position)` — those are the only columns the client can write |
| You can't forge Claude's tier suggestion or a no-photo exemption | a trigger strips them from every client insert; only `create_structured_tasks` (service role) sets them |
| Late additions are flagged by the server, not self-reported | `tasks_insert_guard` trigger reads `daily_state` |
| Rejections, spot checks and overrides can't be erased | `verification_attempts` has no `delete` policy; `claude_suggested_tier` is not client-writable |
| Photos must be fresh | `verify-proof` rejects a capture stamp older than 2 minutes |

The one deliberate escape hatch is `credit_manual_task`, which the client *can*
call. It exists so the app is usable before the Edge Functions are deployed and
when the API is down. It logs the credit as `MANUAL`, and the weekly review counts
those separately and reports what share of your completion rate was actually
verified from a photo. Self-report tasks (the "no photo needed" tier from §6a of
the spec) are logged the same way, for the same reason: nobody looked at anything.

## Layout

```
src/
  screens/       the 7 screens from §4 of the spec
  components/    camera, session picker, small shared UI
  hooks/         auth, today's data, streak, speech recognition
  lib/           supabase client, API calls, day keys, image resizing
supabase/
  migrations/    schema, RLS, economy functions, storage bucket
  functions/     structure-tasks, verify-proof, weekly-observation
```

## Notes on the build

- **Midnight reset needs no scheduler.** Every row is keyed to the *device-local*
  calendar date. At 00:00 the key changes and today simply has no rows yet. The
  client also re-checks on `visibilitychange`, so a phone that slept through
  midnight lands on tomorrow's gate.
- **Session time is derived, not counted.** The countdown reads
  `started_at + minutes`, so backgrounding the app or reloading it doesn't hand
  you free minutes.
- **Capture time on the fallback path is the file's own mtime.** Picking a photo
  from last Tuesday fails the 2-minute window instead of quietly passing. If a
  file reports no mtime at all the code falls back to "now" — see
  `docs/deviations-from-spec.md` for why, and why that's a hole.
- Ship ugly. Tailwind defaults, no animations, one accent colour, one palette.
