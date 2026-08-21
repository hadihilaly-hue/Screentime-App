# Phase 1 Spec: "EarnedTime" (working title, rename it)

A web app that turns your daily to-do list into currency for screen time. Phase 1 proves the loop works on the honor system, before any iOS blocking is built. You will use it as an installable web app (PWA) on your phone's home screen and as a browser homepage on your laptop.

**Phase 1 goal:** After two weeks of daily use, you can answer: does earning app time by proving completed work actually change my behavior? If yes, Phase 2 (iOS shields) is worth building.

## 1. Stack

| Piece | Choice | Why |
| --- | --- | --- |
| Frontend | React (Vite) + Tailwind, built as a PWA | Installable on iPhone home screen so it feels like an app; you know React from Lumi |
| Backend / DB | Supabase (you already have an account connected) | Auth, Postgres for tasks/sessions, Storage for proof photos, Edge Functions to call the Anthropic API without exposing your key |
| AI | Anthropic API (claude-sonnet-4-6), called from a Supabase Edge Function | Task structuring (text) + proof verification (vision) |
| Voice input | Web Speech API (browser built-in) with a plain-text fallback box | Free, no audio pipeline needed; works well in Chrome, decently in iOS Safari |
| Hosting | Vercel or Netlify free tier | One-command deploys |

**Important:** never put your Anthropic API key in frontend code. All Claude calls go through a Supabase Edge Function that holds the key as a secret.

## 2. The daily loop (user experience)

1. **Morning gate.** First open of the day shows only one screen: "What's your plan today?" Nothing else in the app is accessible until a to-do list exists for today.
2. **Speak or type the list.** You ramble it in ("first ACT math section, then bio homework, then upload the program to my calculator..."). Claude structures it into discrete tasks and proposes a tier for each. You can drag to re-tier or edit before confirming.
3. **Dashboard.** Shows today's tasks grouped by tier, your earned-minutes balance (in its "spendable at 6:00pm" state before the spend window opens), and any active timer.
4. **Complete a task → submit proof.** Tap the task, camera opens inside the app (no gallery access), you take 1 to 3 photos or a short video of the work. Claude Vision checks it against the task description and either verifies, rejects with a reason, or asks one follow-up question you must answer in the app.
5. **Spend minutes — but only after 6pm, and only by opening the site.** A verified task deposits minutes into your balance at whatever hour you finish it. Between 6:00pm and midnight, opening a tracked site lands you on the block page, where you pick 5/10/15/20 minutes and that tap starts the session and lets you through. Between 9:00am and 6:00pm, and again after midnight, the site is simply locked and no session can start; between 7:00am and 9:00am it is open to begin with and costs nothing. When the timer hits zero the app shows a full-screen "time's up" state, the site re-blocks, and the session is logged. See section 3A for the full schedule.
6. **Full completion bonus.** All of today's tasks verified = balance becomes unlimited until midnight.
7. **Midnight reset.** Balances zero out, tasks archive, tomorrow starts at the morning gate again.

Phase 1 enforcement is honor-system **on the phone**: the timer doesn't actually block Snapchat, it just runs, and you commit to only opening the app while a session is active. On the laptop the Chrome extension in `extension/` is a real wall — it enforces both the schedule and the session. The point is to test whether the economy changes behavior; the phone's walls come in Phase 2.

## 3. The earning economy (starting values, tune after week 1)

| Tier | What it means | Earns |
| --- | --- | --- |
| Tier 1 | Big, hard, most important (ACT section, full problem set) | 20 min |
| Tier 2 | Medium (regular homework, annotating a chapter) | 12 min |
| Tier 3 | Small chores (upload calculator program, email a teacher) | 5 min |

Rules:

- Daily cap of 60 earned minutes total (prevents grinding small tasks into infinite Clash Royale).
- Minutes are a shared balance spendable on any tracked app, in 5/10/15/20 minute sessions, inside the spend window only (section 3A).
- **The currency has a daily two-hour holiday.** 7:00am–9:00am is open: the tracked sites cost nothing and need no session. That is deliberate — a wall with no door at all gets climbed, and the morning is the one time of day the pull is weakest — but it does mean roughly two of every twenty-four hours are outside the economy entirely. If week 1 shows the morning quietly becoming the whole budget, shorten it; that is the first dial to turn.
- Unused minutes expire at midnight. No banking. This matters: banking lets you save up for a binge day.
- Tier assignments are suggested by Claude but you confirm them, so you can't quietly call everything Tier 1. Log when you override Claude's suggestion; review those overrides weekly.

## 3A. The daily schedule (time windows)

Earning runs all day. **Spending is confined to one window.** Every time below is
the local wall-clock time of the device — the same clock `todayISO()` and the
extension already use. Never UTC, never a server time.

| Window | Hours | Tracked sites | Sessions |
| --- | --- | --- | --- |
| **Open** | 7:00am – 9:00am | Not blocked | None needed. Nothing is metered, nothing is spent |
| **Hard block** | 9:00am – 6:00pm | All blocked | Cannot start. Block page reads "Locked until 6:00pm" and shows no session buttons |
| **Spend window** | 6:00pm – 12:00am | Blocked by default | Started from the block page: 5/10/15/20 min |
| **Hard cutoff** | 12:00am – 7:00am | All blocked | Cannot start. Block page reads "Locked until 7:00am" and shows no session buttons |

The rules that fall out of that table:

- **The clock decides first, the `sessions` table second.** Outside the spend
  window a running session unlocks nothing. This is what makes 9am–6pm a wall
  rather than a suggestion: there is no state you can get the database into that
  opens a tracked site at 2pm.
- **A session cannot outlive the window.** One started at 11:55pm with 20
  minutes on it is cut off at 12:00am, the same moment the balance resets. The
  extension caps every unlock at the window's end, so midnight re-blocks and
  evicts open tabs exactly as the end of a session already does.
- **Boundaries fire on an alarm, not on the poll.** The extension sets an alarm
  for the next boundary, so 9:00am blocks at 9:00am rather than up to a minute
  later. The one-minute poll stays as the safety net it already was.
- **The windows are fixed.** They are not configurable in Phase 1 — the point of
  a schedule you cannot edit at 2pm is that you cannot edit it at 2pm.

### Opening the site is what starts the session

There is no "start a session" control in the web app any more. In the spend
window the loop is:

1. You open a tracked site. It is blocked, so you land on the block page.
2. The block page shows the shield, your balance, and four buttons: 5, 10, 15,
   20. Any length you cannot afford is disabled.
3. You tap one. That single tap spends the minutes, writes the session row,
   drops the block, and sends you on to the URL you originally asked for.
   **If the block does not actually lift, the minutes still go.** A tap that is
   definitively refused — by the browser rejecting the rules, or by the worker's
   own decision leaving the site blocked — is not refunded. Instead the session
   is closed, so that it does not open the site later; that close is attempted
   with capped retries rather than guaranteed, and the block page says which
   happened, including when it could not confirm the close.

   The bias is deliberate: where the economy has to fail, it should fail towards
   overcharging you rather than towards a free unlock. Being short a few minutes
   is recoverable by finishing another task; an unlock nobody paid for is the
   thing this whole schedule exists to prevent. That is a bias and not a
   guarantee — one hole is known and left open, because closing it needs the
   debit and the insert in one transaction: an insert that commits but whose
   response is lost refunds the minutes while its session row survives
   (`extension/spend.js`). (`extension/README.md` has the exact branches.)
4. When it expires the site re-blocks and open tabs are evicted, exactly as
   built today. Ending early re-blocks within the poll interval (up to a
   minute), also as built today — the app cannot signal the extension, so the
   worker notices on its next check rather than on the tap. **Eviction is
   unconditional**: every check sends any tab sitting on a blocked site to the
   block page, rather than only the check that re-applies the rule. A redirect
   rule only sees network requests, and a site with a service worker can serve
   a reload from its own cache without making one — so the rule alone is not
   enough to clear a tab that is already open.

**The open *is* the session start.** You never decide in the abstract how long
you want; you decide at the door, with the balance in front of you. The web app
keeps the countdown (screen 6) and the balance, so the running session is still
visible there — it just is not started there.

### Earning any hour, spending after 6pm

Task completion and proof submission are allowed at **any** hour, in every
window. Minutes earned at 10am are real and are added to the balance
immediately; they are simply not spendable until 6:00pm.

The dashboard has to say so out loud, or a growing balance that buys nothing
reads as a bug. Before 6pm the balance is shown in a **"spendable at 6:00pm"**
state — the number, plus the window it unlocks in and a countdown to it. This is
computed client-side from the device clock. No column, no table, no migration:
`balances.minutes_available` still means exactly what it meant.

## 3B. The always-allowed list

Six things are **never blocked and never tracked**, in any window, in any phase,
on any platform:

**Phone · FaceTime · Messages · Lyft · Waymo · DoorDash**

They do not appear in `TRACKED_APPS`, they cannot be added to the extension's
`sites`, they cannot have a session, and the hard-block windows do not touch
them. Calling someone, texting someone, getting a ride, and eating are not
screen time to be earned. A schedule that can strand you without a way to call
home is a schedule that gets uninstalled the first time it matters — and Phase 2
(iOS shields) inherits this list unchanged.

This is one half of a general rule: **blocking is opt-in, per app and per site.**
Nothing is blocked because it exists; something is blocked because it was added
to `TRACKED_APPS` (app) or to `sites` in `extension/config.js` (laptop). The
always-allowed six are the permanent exclusion from that opt-in — the one list
you are not allowed to add to the blocked side, enforced in code rather than
left to good intentions:

- `ALWAYS_ALLOWED` in `src/lib/constants.ts` and `extension/always-allowed.js`.
- The extension drops any configured site that matches it before a single rule
  is written, so a typo in `config.js` cannot block a ride home.
- `startSession` refuses an always-allowed app name, so one cannot be metered
  through the back door either.

## 4. Screens (7 in the web app, plus the block page)

1. **Morning Gate.** Mic button, live transcript, text fallback, "Structure my day" button. Blocks all navigation until confirmed.
2. **Task Review.** Claude's structured list with tiers. Drag to reorder/re-tier, edit titles, delete, add. Confirm button locks the list for the day (edits after confirmation allowed but flagged in the weekly review, so adding easy tasks at 9pm is visible to future-you).
3. **Dashboard.** Minutes balance (big number) with the current window and, before 6pm, a "spendable at 6:00pm" countdown; task list with status chips (todo / pending proof / verified / rejected); streak counter. **No Start Session button** — sessions start at the block page (section 3A), so the dashboard's spend panel is a read-only explanation of when and how the balance can be spent.
4. **Proof Capture.** In-app camera only (`getUserMedia`, or `<input type="file" accept="image/*" capture="environment">` on iOS which opens the camera directly). Client stamps capture time; server rejects files older than 2 minutes as an upload-bypass guard.
5. **Verification Result.** Verified (minutes added, small celebration), Rejected (Claude's reason, retake), or Follow-up (one question about the content, your typed answer goes back to Claude for a final verdict).
6. **Active Session.** Full-screen countdown for the app whose site you opened. Reached by *having* a running session, not by starting one here. The countdown is clamped to the end of the spend window, so a session started at 11:55pm shows five minutes, not twenty — the same clamp the extension applies to the unlock. "Time's up" state requires a tap to acknowledge and logs the session; ending early logs it too, and the site re-blocks on the extension's next check (up to a minute later).
7. **Weekly Review.** Every Sunday: completion rate, minutes earned vs. spent per app, tier overrides, late-added tasks, and a short Claude-written observation of your patterns with one suggested rule change for next week.

**8. Block page (`extension/blocked.html`).** Not a web-app route — it is what a
tracked site becomes when it is blocked, and since section 3A it is the only
place a session can start. It shows the shield, the site's name, your balance,
one randomly picked quote from `extension/quotes.js` per page load, and either
the four session-length buttons (spend window, disabled below your balance) or a
"Locked until 6:00pm / 7:00am" line with no buttons at all (every locked
window). In the open window it shows neither panel: nothing is blocked then, so
the page releases itself instead of explaining a wall that is not there.
It carries the same dark palette and acid accent as the app, so the wall reads as
part of the same product rather than a browser error.

## 5. Data model (Supabase tables)

```
tasks
  id, user_id, date, title, tier (1|2|3), status
  (todo | pending | verified | rejected),
  claude_suggested_tier, proof_urls[], verification_notes,
  created_after_confirmation (bool), verified_at

balances
  user_id, date, minutes_available, minutes_earned_total,
  all_tasks_bonus (bool)

sessions
  id, user_id, date, app_name, minutes, started_at, ended_at

daily_state
  user_id, date, list_confirmed (bool), confirmed_at
```

Row Level Security on, keyed to your user id. It's a personal app but do it anyway; it's one toggle and it's the right habit.

**The schedule adds no columns.** Which window you are in, whether a balance is
spendable yet, and when it becomes spendable are all functions of the device
clock, computed where they are displayed (`src/lib/schedule.ts` in the app,
`extension/schedule.js` in the extension — same four windows, same boundaries,
deliberately duplicated because the extension has no build step and imports no
TypeScript). Storing any of it would only create a second source of truth that
can disagree with the clock.

## 6. The two Claude prompts

### 6a. Task structuring (Edge Function: `structure-tasks`)

System prompt:

```
You convert a student's spoken morning ramble into a structured task list.

Rules:
- Split into discrete, verifiable tasks. "Study for bio and math" becomes two tasks.
- Each task gets: title (short, concrete), tier (1, 2, or 3), and proof_hint
  (one sentence describing what photo evidence of completion would look like).
- Tier 1 = major academic work (test prep sections, essays, problem sets).
  Tier 2 = standard homework or focused study blocks.
  Tier 3 = quick logistics (emails, uploads, packing).
- If a task is too vague to verify with a photo ("think about my project"),
  keep it but set tier 3 and proof_hint to "self-report, no photo needed".
- Respond ONLY with a JSON array:
  [{"title": "...", "tier": 1, "proof_hint": "..."}]
  No markdown fences, no preamble.
```

User message: the raw transcript.

### 6b. Proof verification (Edge Function: `verify-proof`)

System prompt:

```
You verify whether photo evidence shows a completed task. The user is a
motivated student who will sometimes try to pass off partial or old work.
Be fair but skeptical.

You receive: the task title, its proof_hint, and 1-3 photos.

Decide:
- VERIFIED: evidence clearly matches the task. Handwritten work should look
  substantive, not token (a page with 2 pencil marks is not an annotated page).
- FOLLOW_UP: plausible but you want confirmation the user actually did the
  work. Ask ONE specific question answerable only by someone who did it
  (e.g. "What did you get for question 14?" or "What was the passage about?").
- REJECTED: evidence doesn't match, looks incomplete, or is unreadable.
  Give a one-sentence reason and what a passing photo would show.

Respond ONLY with JSON:
{"verdict": "VERIFIED" | "FOLLOW_UP" | "REJECTED",
 "reason": "...", "follow_up_question": "..." | null}
No markdown fences.
```

Follow-up answers get sent back with the full prior exchange for a final VERIFIED/REJECTED verdict.

## 7. Anti-cheat rules (Phase 1 versions)

- In-app camera only; server rejects images whose capture timestamp is more than 2 minutes old.
- Random follow-up: even on clear VERIFIED cases, 1 in 4 verifications asks a content question anyway. Randomness is what makes faking expensive.
- Everything is logged, nothing is deletable: rejected proofs, tier overrides, tasks added after morning confirmation, and sessions all appear in the weekly review. Phase 1's real enforcement is visibility.
- The schedule is enforced from the clock, not from the data (section 3A). There is no row you can write, and no session you can leave open, that unlocks a tracked site between 9am and 6pm or after midnight — so the only cheat left on the laptop is disabling the extension, which is loud and deliberate rather than quiet.
- Sessions are started at the wall, not in the app. Choosing a length in the abstract at 4pm is exactly the decision that gets made too generously; choosing it at the door at 8pm, with the balance in front of you, is the same decision with the cost attached.

**Known limits, accepted for now:** you could photograph a sibling's homework, or open Snapchat with no session running. Phase 1 doesn't try to stop that; it measures whether you do. If week 2 shows constant cheating, that is itself the finding, and it means Phase 2 needs to be stricter, not that the idea failed.

## 8. Build order

**Weekend 1: the economy works, no AI yet**

1. Vite + React + Tailwind scaffold, Supabase project, auth (just your account), tables above.
2. Morning gate with text input only; manual task entry with manual tier picking.
3. Dashboard with balance math (hardcode tier values), session timer with full-screen countdown and logging.
4. Midnight reset (a Supabase scheduled function, or compute "is this task from today" client-side, which is simpler).
5. Deploy, add to iPhone home screen as PWA, set as laptop browser homepage. Use it Monday.

**Weekend 2: AI + proof**

6. Edge Function `structure-tasks` + Web Speech API mic input feeding it.
7. Proof capture flow, Supabase Storage upload, Edge Function `verify-proof` with vision, the three verdict states.
8. Full-completion bonus and streak counter.
9. Weekly review page (static stats first; the Claude-written observation can wait for weekend 3).

**Landed after weekend 1, out of order:** the Chrome extension (`extension/`),
the visual pass on the web app, and the section 3A schedule + section 3B
always-allowed list. The extension exists because the laptop was where the
honour system failed first; the schedule exists because an always-available
balance turned into an evening-shaped problem with no edges.

**Rule for both weekends: ship ugly.** Tailwind defaults, no animations, no dark mode. Every hour on polish in Phase 1 is an hour stolen from finding out if the loop works.

## 9. What Phase 1 deliberately does NOT include

- Any actual blocking **on the phone** (that's Phase 2: iOS FamilyControls entitlement + Swift). The laptop is blocked today by the Chrome extension in `extension/`, which also enforces the section 3A schedule.
- Editable windows. The schedule is the four fixed windows in section 3A — no per-app schedules, no "just 15 more minutes", no weekend variant.
- Banking minutes past midnight, or carrying an unfinished session across the midnight cutoff.
- Video proof (photos only; video adds upload and review complexity for little extra verification power).
- "Scientifically optimal" session lengths (doesn't exist; you'll tune from your own week 1 data).
- Multiple users, sharing, or anything App Store shaped. This is a tool for one person: you.

## 10. How you'll know Phase 1 worked

Track for two weeks, then look at the numbers in the weekly review. **The laptop and the phone are now measured differently**, because the Chrome extension in `extension/` landed early and actually blocks the tracked sites there. That was a deliberate trade: it buys a real wall on the laptop, and it costs the honour-system reading on that half of the surface. You cannot measure whether someone opens a site they were free to open once they are no longer free to open it.

**Phone (still honour-system — this is where the cheat rate lives):**

1. Sessions opened WITHOUT an active timer (self-reported or noticed). This is your cheat rate, and the phone is now the only place it can be observed.
2. Whether the morning gate ever felt worth skipping the app entirely to avoid.

**Laptop (blocked, so measure behaviour instead of honesty):**

3. Usage totals on the tracked sites — minutes actually spent inside started sessions, from the `sessions` table. Every one of those rows now carries a start time inside the 6pm–midnight window, so the shape of the evening is readable directly: how early you spend, and how much of the balance survives to midnight unspent.
4. Task completion rate vs. a normal week (be honest about the baseline).

Completion up + phone cheat rate tolerable = build Phase 2. Phone cheat rate near 100% = the design needs external walls on the phone too (parent-held Screen Time passcode), and the app becomes the door through them — which is what the extension already is on the laptop.
