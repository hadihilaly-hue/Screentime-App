# EarnedTime — Phase 2 iOS Spec

**Status:** Draft v1
**Owner:** Hadi
**Target:** iOS 17+, SwiftUI, Swift 5.9+, Xcode 16+
**Backend:** Existing Supabase project `lkpvcxyveulfpkbcyyxi` — unchanged

---

## 1. Purpose

Replace honor-system enforcement on iPhone with real blocking via Apple's Screen Time API (FamilyControls + ManagedSettings + DeviceActivity). The phone is the real problem surface — Instagram, Snapchat, YouTube, Clash Royale, Brawl Stars all live there.

Phase 1 (web app + Chrome extension) stays exactly as it is. The iOS app is a **second client of the same backend**, not a replacement.

## 2. Non-goals — read this section twice

- **No new Supabase tables, columns, RPCs, or Edge Functions.** If the iOS app seems to need one, stop and report; do not build it.
- **No changes to the economy.** Tiers, daily cap, bonus, no-refund policy, CAS on earn/spend — all live in Supabase and `src/lib/*.ts` already. iOS reads and calls; it does not reimplement rules.
- **No App Store / TestFlight distribution.** Development-signed builds installed from Xcode to one phone. Do not request the Family Controls distribution entitlement.
- **No parental-control UI.** There is one user, and it is the developer.
- **No notifications, widgets, Live Activities, or Watch app.**
- **No offline queue.** Offline = blocked, and actions fail with a clear message. Same as Phase 1.
- **No auto-refund, no grace periods, no "just this once" overrides.** These were built, broke things three times, and were deliberately deleted in Phase 1.

## 3. Blocking model

Supabase is the source of truth for *whether access is allowed right now*. The phone mirrors it, but enforcement must survive the app being closed, killed, or offline.

### 3.1 Daily windows (same as Phase 1)

| Window | Local time | Phone behavior |
|---|---|---|
| Open | 07:00–09:00 | Shield off |
| Hard block | 09:00–18:00 | Shield on, no spending possible |
| Earn/spend | 18:00–24:00 | Shield on by default; lifted only during an active session |
| Cutoff | 00:00–07:00 | Shield on |

Windows are enforced **on-device** via `DeviceActivitySchedule` so they fire even when the app is dead. The schedule definition is hardcoded to match the server; it is not fetched.

### 3.2 Sessions

- A session is started **from the shield screen** (the thing you see when you open a blocked app), not from the dashboard. Open-triggers-countdown, same as Phase 1. The shield offers exactly three choices: **5 / 10 / 15 min**. Anything the balance or window does not allow is shown disabled, not hidden.
- Tapping a choice does **not** spend yet. It hands off to the main app, which shows a full-screen **Breathe** pause: one quote, a 15-second countdown, and a "Use Snapchat for 10 min" confirm button that is disabled until the countdown ends. Backing out costs nothing. Only confirm spends.
- Every shield hit is logged (timestamp, app token hash, whether a session was started, which duration) so Phase 3 can analyze patterns. Use the existing `sessions` table if it has room for this; if it does not, **report, do not add a table.**
- Starting a session calls the **existing** Supabase spend path (the same one the web app uses — find it in `src/lib/`, do not invent a new one). If the CAS fails, the session does not start and the shield stays up.
- On success: lift the shield for the blocked set, and register a one-shot `DeviceActivitySchedule` ending at `session.ends_at`. The `DeviceActivityMonitor` extension re-applies the shield at that moment regardless of app state.
- Ending early: app calls the existing end-session path, then re-shields immediately. No refund (policy).
- **Always-allowed apps are never shielded:** Phone, FaceTime, Messages, Lyft, Waymo, DoorDash. User selects these once via `FamilyActivityPicker`; tokens persist in the App Group.

### 3.3 Fail-closed rules

- App launch, foreground, and every poll: if Supabase is unreachable → shield on.
- If the local session timer and server disagree → shield on, and surface the mismatch in the UI.
- If FamilyControls authorization is revoked → show a full-screen "authorization required" state; nothing else works until restored.

### 3.4 Blocked set

User picks blocked apps once via `FamilyActivityPicker`. Store the `FamilyActivitySelection` in the App Group `UserDefaults`. Initial picks: Instagram, Snapchat, YouTube, Clash Royale, Brawl Stars, plus Safari web domains `youtube.com`, `instagram.com`, `snapchat.com`.

## 4. Targets

| Target | Kind | Job |
|---|---|---|
| `EarnedTime` | iOS app | SwiftUI dashboard, auth, polling, picker, applies/lifts shields |
| `EarnedTimeMonitor` | DeviceActivityMonitor extension | Re-shields at window boundaries and session end |
| `EarnedTimeShield` | ShieldConfiguration extension | Custom shield screen: balance, "Spend N min" button, quote |
| `EarnedTimeShieldAction` | ShieldAction extension | Handles the spend button tap → starts session |

All four share one App Group. Both `com.apple.developer.family-controls.development` and the App Group capability on every target.

## 5. Screens (SwiftUI)

Match the Phase 1 visual language: dark palette, mobile-first, acid-green balance as the hero element.

1. **Sign in** — Supabase email/password (same accounts as web). Persist session in Keychain.
2. **Setup** (first run only) — request FamilyControls authorization → pick blocked apps → pick always-allowed apps.
3. **Today** — balance (hero), current window, active session countdown if any, today's tasks with status, and the **blocked-apps list** rendered from the stored tokens (icon + name via `Label(token)`). The list is **display-only**: tapping an app does nothing. There is no start-session button anywhere in the main app; sessions begin only from the shield.
   - **Add App** button: on first run it is the primary call-to-action on the Setup screen. After that it is a small `+` icon in the top-right of the Today toolbar. It opens `FamilyActivityPicker`.
4. **Task detail / proof** — camera-only capture (no photo library), upload to `proofs/<user>/<task>/N.jpg`, call `verify-proof` Edge Function, show verdict. Mirrors `src/lib/proof.ts` exactly.
5. **Shield** (extension) — balance, spend options by tier, "Nothing to spend" if balance is 0 or outside the spend window.

## 6. Supabase integration

- Use `supabase-swift` (official SDK).
- Anon key + URL from an `xcconfig` file that is gitignored; commit an `.xcconfig.example`.
- Every read/write goes through the same tables and RLS policies the web app uses. If a query is denied by RLS or a column grant, that is a bug in the iOS code's assumptions, not a reason to loosen the policy.
- Polling: on launch, on foreground, and every 60s while foregrounded. Nothing in the background — DeviceActivity handles background enforcement.

## 7. Milestones — build in this order, stop after each for review

1. **M1 Blocking skeleton (no backend).** Auth request, pickers, shield on/off via a debug toggle, DeviceActivity window schedule. Proves the entitlement works on-device. *Ship nothing else until this runs on the phone.*
2. **M2 Read-only dashboard.** Sign in, show balance and tasks from Supabase. Shield still driven by the debug toggle.
3. **M3 Sessions.** Start from shield, spend via existing path, lift shield, re-shield at end. Early end. Fail-closed on network error.
4. **M4 Proof capture.** Camera, upload, `verify-proof` call, verdict display.
5. **M5 Polish.** Setup flow, error states, authorization-revoked state.

Each milestone ends with a spec-checker pass: list anything built that is not in this document.

## 8. Acceptance tests (manual, on a real device)

- [ ] At 09:05 with the app force-quit, Instagram shows the EarnedTime shield.
- [ ] At 18:30 with balance 0, the shield shows "Nothing to spend"; no button starts a session.
- [ ] Spend 20 min at 18:30 → Instagram opens. Force-quit EarnedTime. At 18:50 Instagram is shielded again.
- [ ] Airplane mode → tapping "Spend" fails with a network error and the shield stays up.
- [ ] End a session early → shield returns within 5 seconds; balance does not change.
- [ ] Phone, Messages, FaceTime, Lyft, Waymo, DoorDash open in every window.
- [ ] Same Supabase balance shows on phone and web after any action.

## 9. Known constraints and open questions

- **Family Controls does not run in the Simulator.** M1 onward requires the paid Apple Developer account (parent-held) and a physical iPhone. M2 UI work can start in the Simulator.
- **App tokens are opaque.** The app cannot know *which* apps are selected; it only holds tokens. Don't try to "verify" that Instagram is in the set.
- **Shield extensions have tight memory and time limits.** Keep `EarnedTimeShieldAction` to a single network call with a short timeout; on failure, return `.defer` and leave the shield up.
- **Open:** should the spend-window boundary at 18:00 be checked server-side by the existing spend path, or is it already? Check before M3. If the server does not enforce it, report — do not add a check in iOS only.
- **Open:** `daily_state` reset timing vs. the UTC-based `verification_attempts.day` seam noted in migration 05. iOS must use the same local-date logic as the web app for "today".

## 10. Explicitly deferred (do not build in Phase 2)

These are real plans; they are out of scope here because they change the economy or need a new backend feature, and both clients must inherit them together.

- **Daily cap 30–45 min, scaled by workload** (more tasks → lower cap). Backend + `src/lib` change, own migration. "Phase 1.5 economy."
- **Weekend schedule** (wider windows, higher cap). Same bucket.
- **Canvas sync** — Edge Function that writes assignments into `tasks`. Depends on Menlo allowing student API tokens. Phase 3.
- **Usage insights** — analysis of EarnedTime's own session/shield-hit logs after ~1 month of data. Phase 3. Note: Apple does not let the app read system Screen Time data; only EarnedTime's own events are analyzable.

## 11. Canonical branch and workflow

- Branch: `claude/earnedtime-folder-setup-nwm5p5`. Confirm with `git branch --show-current` at the start of every session.
- iOS code lives in `ios/` at the repo root. Do not touch `src/`, `extension/`, or `supabase/`.
- Builds and device installs happen on the Mac, not in cloud Claude Code.
