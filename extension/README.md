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

## How it works

- Blocking is `declarativeNetRequest` redirect rules — one per site, plus one
  extra for YouTube that catches iframes **only when the parent page is
  youtube.com itself**, so a YouTube embed on someone else's blog still plays.
- Subdomains are covered (`requestDomains` matches the domain and everything
  under it).
- Every minute, and again at the exact moment a running session ends, the
  extension asks Supabase for sessions with `ended_at` null whose
  `started_at + minutes` is still in the future. Sites with such a session have
  their rules removed; everything else stays blocked.
- When a site goes back to blocked, tabs already sitting on it are redirected
  too — you do not have to reload for the block to come back.
- **It fails closed.** Signed out, offline, or Supabase erroring, everything
  stays blocked.

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
- A session that starts while you are already staring at a blocked page needs a
  reload, or up to a minute for the next poll, before the site opens.
- The clock comes from your machine, same as the web app.
