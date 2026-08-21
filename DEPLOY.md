# Deploying EarnedTime to Vercel

Click-by-click, from a GitHub repo you already own to a URL you can open on your
phone. Free tier is enough — this is a static bundle plus one Supabase project.

You need, before you start:

- the GitHub repo (`hadihilaly-hue/Screentime-App`)
- a Vercel account (sign in with GitHub — it makes step 2 one click instead of
  several)
- your Supabase project's **URL** and **anon public** key, from
  Supabase → your project → **Project Settings → API**

Total time is about ten minutes, most of it waiting for the first build.

Vercel's dashboard gets reworded from time to time. Where a button name here is
slightly off, the thing you are looking for is described as well as named.

---

## 0. Know which branch you are deploying

**This is the step people skip, and it is the one that makes a deploy
mysteriously ship old code.**

Vercel builds one branch as production: whatever this repo's **default branch**
is on GitHub. Right now that is `claude/earnedtime-folder-setup-nwm5p5`, and the
work described in this file is on `claude/vercel-deploy-proof-of-work-63fz61`.
Those are different branches, so out of the box Vercel would deploy the wrong
one.

Pick one of these before you import — either is fine:

- **Merge first (simplest).** Merge `claude/vercel-deploy-proof-of-work-63fz61`
  into the default branch on GitHub, and let Vercel use the default. Every later
  push to that branch redeploys.
- **Point Vercel at the feature branch.** Import as-is, then in
  **Project → Settings → Git → Production Branch**, change it to
  `claude/vercel-deploy-proof-of-work-63fz61` and click **Save**. Then trigger a
  redeploy (step 5) — changing the branch does not rebuild on its own.

Whichever you pick, note the branch name. You will confirm it in step 5.

---

## 1. Start the import

1. Go to **https://vercel.com** and sign in with GitHub.
2. On the dashboard, click **Add New…** (top right) → **Project**.
3. You land on **Import Git Repository**, a list of your GitHub repos.
4. Find **Screentime-App**. Click **Import** next to it.

**If the repo is not in the list:** click **Adjust GitHub App Permissions**
(or **Configure GitHub App** / **Add GitHub Account**) under the list. That
opens GitHub's install screen for the Vercel app. Either grant **All
repositories**, or **Only select repositories** → add **Screentime-App** →
**Save**. GitHub sends you back to Vercel and the repo appears.

---

## 2. Check the build settings — do not change them

Vercel shows a **Configure Project** screen. It should have detected this as a
Vite app on its own. Confirm, rather than edit:

| Field | Should say | Why |
| --- | --- | --- |
| Framework Preset | **Vite** | Sets the two rows below automatically |
| Root Directory | `./` | The app is at the repo root; `extension/` is not built |
| Build Command | `npm run build` | Typechecks, then builds |
| Output Directory | `dist` | Where Vite writes |
| Install Command | `npm install` | Default |

If the preset says **Other**, set it to **Vite** and the rest fills itself in.

The client-side routing is already handled: `vercel.json` in the repo rewrites
every path to `/index.html`, so opening `https://…/dashboard` directly works
instead of 404ing. You do not configure that here, and you do not need to.

**Do not click Deploy yet.** Do step 3 first.

---

## 3. Set the environment variables (before the first build)

Still on **Configure Project**, expand **Environment Variables**.

This ordering is not fussiness. Vite bakes `VITE_*` values into the JavaScript
bundle **at build time** — they are not read when the app runs. A build with
these missing produces a bundle that throws on load and shows *"EarnedTime
failed to start"*, deliberately, rather than an app with nothing behind the auth
gate. Set them first and the first build is the right one.

Add these, one at a time (**Key**, then **Value**, then **Add**):

| Key | Value | Required? |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `https://<your-project-ref>.supabase.co` | **Yes** |
| `VITE_SUPABASE_ANON_KEY` | the long `eyJ…` anon key | **Yes** |
| `VITE_EXTENSION_ID` | the Chrome extension's id | Optional |

Both required values are on the same Supabase page: **Project Settings → API**.

- `VITE_SUPABASE_URL` is under **Project URL**.
- `VITE_SUPABASE_ANON_KEY` is the key labelled **anon** / **public**.
  **Never use `service_role`.** Everything in a `VITE_*` variable is readable by
  anyone who opens the bundle; the anon key is designed for that and RLS is what
  protects your rows. The `service_role` key bypasses RLS entirely.
- `VITE_EXTENSION_ID` is the long lowercase id on the extension's card in
  `chrome://extensions`. It only makes ending a session early re-block in about
  a second instead of on the extension's one-minute poll. Leave it out now and
  add it later if you want it — see step 7.

If Vercel asks which environments each variable applies to, leave **all** of
Production, Preview and Development ticked.

---

## 4. Deploy

Click **Deploy**.

The build takes a minute or two. When it finishes you get a confetti screen with
a screenshot of the app. Click **Continue to Dashboard**.

Your URL is on the project page under **Domains** — it looks like
`https://screentime-app.vercel.app` or `https://screentime-app-<something>.vercel.app`.
**Copy it. Steps 5, 6 and 7 all need it.**

**If the build fails**, click the failed deployment and read the log:

- `Cannot find module` or a TypeScript error → a real code problem; the same
  error reproduces locally with `npm run build`.
- Build succeeds but the page says *"EarnedTime failed to start"* → the env vars
  are missing or were added after the build. Fix them in step 3's screen
  (**Settings → Environment Variables**) and redeploy per step 5.

---

## 5. Confirm you deployed the branch you meant to

On the project page, look at the top deployment. It shows the branch and the
commit message it built.

- Right branch, right commit → done, move on.
- Wrong branch → go back to step 0, fix the Production Branch or merge, then
  **Deployments** tab → the **⋯** menu on the newest deployment → **Redeploy**
  → **Redeploy** to confirm.

Now open the URL. You should get the EarnedTime sign-in screen. Sign in with the
email and password of the user you created in Supabase (**Authentication →
Users**; there is no signup flow in the app, by design).

If sign-in fails with a network or CORS error rather than "Invalid login
credentials", do step 6 and try again.

---

## 6. Tell Supabase about the new URL

Supabase → your project → **Authentication** → **URL Configuration**.

1. **Site URL** — set it to your Vercel URL, no trailing slash:

   ```
   https://screentime-app.vercel.app
   ```

2. **Redirect URLs** — click **Add URL** and add the wildcard form:

   ```
   https://screentime-app.vercel.app/**
   ```

   Add `http://localhost:5173/**` too if it is not already there, so
   development keeps working.

3. **Save**.

**What this actually affects, honestly:** EarnedTime signs in with email and
password (`signInWithPassword`), which is a plain API call and does not use a
redirect. So password sign-in works whether or not you do this step. It matters
the moment anything email-based is used — a password reset link, or a magic
link — because Supabase refuses to redirect to a URL that is not on that list,
and the link silently lands you back on the wrong origin. It is one field, it
costs nothing, and forgetting it is annoying to debug later.

Supabase does not restrict API calls by browser origin on the free tier, so
there is no separate "allowed origins" list to fill in for the app's normal
reads and writes. If you see a CORS error, it is a wrong `VITE_SUPABASE_URL`
(typo, or a different project), not a missing origin setting.

---

## 7. Point the Chrome extension at the deployed app

Only if you run the laptop blocker. Both halves are optional and independent;
the extension keeps blocking correctly with neither.

1. `extension/config.js` → set `dashboardUrl` to your deployed dashboard:

   ```js
   dashboardUrl: 'https://screentime-app.vercel.app/dashboard',
   ```

2. `extension/manifest.json` → find the line marked `PLACEHOLDER` under
   `externally_connectable.matches` and replace it with your real origin. Keep
   the `https` and the trailing `/*`:

   ```json
   "https://screentime-app.vercel.app/*"
   ```

   The other two entries there are `http://localhost/*` and
   `http://127.0.0.1/*` — those are the dev server, and `http://host/*` does not
   match an `https` origin, which is why the deployed one needs its own line.

3. Hit **Reload** on the extension's card in `chrome://extensions`. Chrome reads
   the manifest at load time; without the reload the new origin is not allowed
   yet.

4. If you want the fast re-block, also set `VITE_EXTENSION_ID` in Vercel
   (step 3) and redeploy — the app has to be rebuilt to pick it up.

Skip all of this and nothing breaks: ending a session early re-blocks on the
extension's one-minute poll instead of in about a second. Details in
[`extension/README.md`](extension/README.md).

---

## 8. Add it to your iPhone home screen

On the phone, in **Safari** (this does not work from Chrome on iOS):

1. Open your Vercel URL.
2. Tap the **Share** button (the square with the up arrow).
3. Scroll down → **Add to Home Screen**.
4. The name should already say **EarnedTime**. Tap **Add**.

It launches full-screen with no Safari chrome, dark from the first frame. That
comes from `public/manifest.webmanifest` (`display: standalone`, the two icons)
and the `apple-touch-icon` in `index.html`; all of it is in the repo and ships
with the build.

Two iOS quirks worth knowing:

- **The icon is cached hard.** If you change `public/icon-192.png`, remove the
  home screen icon and re-add it — iOS will not repaint an existing one.
- **The home-screen app has its own cookie and storage jar.** Signing in in
  Safari does not sign you in in the installed app. Sign in again once, inside
  it.

---

## After the first deploy

- **Every push to the production branch redeploys automatically.** No command,
  no button.
- **Changing an environment variable does not.** Vite inlined the old value into
  the bundle. Change the variable in **Settings → Environment Variables**, then
  **Deployments → ⋯ → Redeploy**.
- **Preview deployments** get their own URL per branch or pull request. They are
  real, they hit the same Supabase project, and they write the same rows — so
  minutes earned on a preview URL are the same minutes. Treat them as the live
  app, not a sandbox.
- **Vercel does not deploy anything to Supabase.** The schema, its RLS policies
  and your user account are set up in the Supabase dashboard, once, and are not
  touched by a deploy here. See the repo's [`README.md`](README.md).
