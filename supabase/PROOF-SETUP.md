# Setting up proof verification

Four things have to exist before tapping **Complete** on a task does anything:
two SQL migrations, a storage bucket, an Anthropic API key, and the
`verify-proof` Edge Function that holds that key.

Written assuming you have never used the Supabase CLI. Steps 1 and 2 are
clicking around a website; step 3 onwards is a terminal, and every command is
given in full.

Until this is done the app still runs — tapping Complete opens proof capture,
you can take photos, and submitting says plainly that nothing could be
verified. That is the intended failure, not a broken build. It never marks a
task done on its own.

---

## 1. Run the two migrations

Supabase → your project → **SQL Editor** → **New query**.

1. Paste the whole of `supabase/migration-05-proof-verification.sql`, press
   **Run**. It should say *Success. No rows returned*.
2. New query again. Paste `supabase/migration-06-proofs-bucket.sql`, **Run**.

Both are safe to run twice.

**If step 2 fails with `must be owner of table objects`:** your SQL editor role
is not allowed to create policies on Storage's tables. Do that part through the
UI instead — **Storage** → **New bucket** → name it `proofs`, leave **Public**
**off**, create it; then **Storage** → **Policies** → `proofs` → **New policy**
four times, one each for SELECT, INSERT, UPDATE and DELETE, pasting the
matching `using` / `with check` expression from the migration file. The bucket
must be **private**; a public bucket puts photos of your homework behind a
guessable URL.

**Check it worked:** Storage should now list a `proofs` bucket with a padlock
or a *Private* label.

---

## 2. Get an Anthropic API key

1. Go to **https://console.anthropic.com** and sign in (or sign up).
2. **Settings → API Keys → Create Key**. Name it something like
   `earnedtime-verify`.
3. Copy it. It starts `sk-ant-` and it is shown **once** — if you lose it,
   delete the key and make another.
4. You need credit on the account for it to work: **Settings → Billing**. Proof
   verification is cheap — three photos at ~1 MB each is a fraction of a cent
   per check, and the app caps each task at three checks a day.

**This key never goes near the app.** It is not a `VITE_` variable, it is not in
`.env`, and it is not in the browser bundle. It goes into the Edge Function's
secrets in step 6, which is the only place that can read it.

---

## 3. Install the Supabase CLI

Pick the line for your machine and run it in a terminal:

| Machine | Command |
| --- | --- |
| macOS | `brew install supabase/tap/supabase` |
| Windows | `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git` then `scoop install supabase` |
| Anything with Node | no install — put `npx supabase@latest` wherever this guide says `supabase` |

Check it:

```sh
supabase --version
```

You should get a version number. If you get "command not found", the install
did not finish — the `npx` route works without installing anything.

---

## 4. Sign the CLI in

From the repo root (`Screentime-App/`):

```sh
supabase login
```

This opens a browser tab, asks you to authorise, and shows a token to paste
back into the terminal. Do that once; it is remembered.

---

## 5. Link this folder to your project

You need your **project ref** — the random-looking string in your Supabase URL.
Look at the address bar on your project's dashboard:

```
https://supabase.com/dashboard/project/abcdefghijklmnop
                                       ^^^^^^^^^^^^^^^^ this
```

It is also in **Project Settings → General → Reference ID**.

```sh
supabase init
supabase link --project-ref abcdefghijklmnop
```

`supabase link` asks for your database password (the one you set when you
created the project). If you have forgotten it, reset it under **Project
Settings → Database → Database password** — resetting it does not affect your
data or the app.

Two notes on `supabase init`:

- It creates `supabase/config.toml` and a couple of small files. It does **not**
  touch the `.sql` files already in that folder.
- If it says the project is already initialised, that is fine — skip it and go
  straight to `link`.

> **Do not run `supabase db push`, `supabase db reset` or `supabase db pull`.**
> This project's SQL is run by hand in the editor and is not laid out as CLI
> migrations, so `db push` has nothing to push and `db reset` would drop your
> real data. The only CLI commands this setup needs are the two below.

---

## 6. Give the function the API key

```sh
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Confirm it landed (this prints names and a hash, never the value):

```sh
supabase secrets list
```

`ANTHROPIC_API_KEY` should be in the list.

If your key contains characters your shell treats specially, wrap it in single
quotes: `supabase secrets set ANTHROPIC_API_KEY='sk-ant-...'`.

---

## 7. Deploy the function

```sh
supabase functions deploy verify-proof
```

It uploads `supabase/functions/verify-proof/index.ts`, prints a progress line
and finishes with a dashboard URL. Confirm:

```sh
supabase functions list
```

`verify-proof` should be listed as `ACTIVE`.

Leave JWT verification **on** — do not add `--no-verify-jwt`. That flag would
let anyone on the internet call your function and spend your Anthropic credit.

**If it asks for Docker:** you are on an old CLI. Upgrade it (`brew upgrade
supabase`, or use `npx supabase@latest functions deploy verify-proof`) —
current versions bundle the function without Docker.

**If you would rather not use the CLI at all:** Supabase → **Edge Functions** →
**Deploy a new function** → name it exactly `verify-proof` → paste the whole of
`supabase/functions/verify-proof/index.ts` into the editor → **Deploy**. Then
add the secret under **Edge Functions → Secrets → Add new secret**, name
`ANTHROPIC_API_KEY`. The name must match exactly in both places.

---

## 8. Try it

Open the app, tap **Complete** on a task, take a photo, submit.

- **Verified / Not verified / one question** — it works. You are done.
- **"This project has no ANTHROPIC_API_KEY set"** — step 6 did not take, or the
  secret was added after the deploy. Run `supabase secrets list`, then
  re-deploy: `supabase functions deploy verify-proof`.
- **"could not be read (HTTP 404)"** — the function is not deployed, or the name
  is not exactly `verify-proof`. Check `supabase functions list`.
- **"Your photos could not be read back"** — the `proofs` bucket or its policies
  are missing. Go back to step 1.
- **"Sign in again"** — the app's session expired. Reload the page.
- **Anything else** — `supabase functions logs verify-proof` shows what the
  function actually said. The app's message and that log should agree.

---

## What it costs, and the guard on it

Each check sends one to three ~1 MB photos to `claude-sonnet-4-6` — a fraction
of a cent. The app caps it anyway: **three verification attempts per task per
day**, counted server-side in `public.verification_attempts`, which the browser
can read but not write. A follow-up answer is a second API call and spends one
of the three; the app shows how many are left rather than surprising you.

The window is the database's UTC day, not your local one, so it resets in the
early evening in US time zones rather than at your midnight. That is deliberate
— a limit that resets when the phone's clock says so is not a limit — and it is
a cost ceiling, not part of the section 3A schedule.

## How lenient it is, and how to change that

The verifier is set to **lenient**: verify unless the photos clearly do not
match, and ask a question rather than reject when unsure. This is a departure
from `phase-1-spec.md` section 6b, which asks for "fair but skeptical"; the
reasoning is in the comment above `SYSTEM_PROMPT` in
`supabase/functions/verify-proof/index.ts`.

If it waves through things it should not, that string is the dial. Edit it and
re-run `supabase functions deploy verify-proof` — no other step, and nothing on
the app side changes.

## What is deliberately not built

Two anti-cheat rules from `phase-1-spec.md` section 7 are **not** here, because
this feature was scoped without them:

- the server rejecting photos whose capture timestamp is more than two minutes
  old; and
- the random follow-up question on one in four otherwise-clear verifications.

Both push against leniency, which is the disposition that was asked for. They
are listed so their absence is a decision on the record rather than an
oversight.
