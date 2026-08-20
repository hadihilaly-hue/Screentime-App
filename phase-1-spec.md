# Phase 1 Spec: "EarnedTime" (working title, rename it)

> Shipped as **Scrip**. The rename is the only intentional change to the title;
> everything below is the spec as written.

A web app that turns your daily to-do list into currency for screen time. Phase 1
proves the loop works on the honor system, before any iOS blocking is built. You
will use it as an installable web app (PWA) on your phone's home screen and as a
browser homepage on your laptop.

**Phase 1 goal:** After two weeks of daily use, you can answer: does earning app
time by proving completed work actually change my behavior? If yes, Phase 2 (iOS
shields) is worth building.

## 1. Stack

| Piece | Choice | Why |
| --- | --- | --- |
| Frontend | React (Vite) + Tailwind, built as a PWA | Installable on iPhone home screen so it feels like an app; you know React from Lumi |
| Backend / DB | Supabase (you already have an account connected) | Auth, Postgres for tasks/sessions, Storage for proof photos, Edge Functions to call the Anthropic API without exposing your key |
| AI | Anthropic API (claude-sonnet-4-6), called from a Supabase Edge Function | Task structuring (text) + proof verification (vision) |
| Voice input | Web Speech API (browser built-in) with a plain-text fallback box | Free, no audio pipeline needed; works well in Chrome, decently in iOS Safari |
| Hosting | Vercel or Netlify free tier | One-command deploys |

**Important:** never put your Anthropic API key in frontend code. All Claude calls
go through a Supabase Edge Function that holds the key as a secret.

## 2. The daily loop (user experience)

1. **Morning gate.** First open of the day shows only one screen: "What's your
   plan today?" Nothing else in the app is accessible until a to-do list exists
   for today.
2. **Speak or type the list.** You ramble it in ("first ACT math section, then bio
   homework, then upload the program to my calculator..."). Claude structures it
   into discrete tasks and proposes a tier for each. You can drag to re-tier or
   edit before confirming.
3. **Dashboard.** Shows today's tasks grouped by tier, your earned-minutes balance
   per app, and any active timer.
4. **Complete a task → submit proof.** Tap the task, camera opens inside the app
   (no gallery access), you take 1 to 3 photos or a short video of the work.
   Claude Vision checks it against the task description and either verifies,
   rejects with a reason, or asks one follow-up question you must answer in the
   app.
5. **Spend minutes.** Verified task deposits minutes into your balance. You choose
   an app (Snapchat, Instagram, YouTube, Clash Royale, Brawl Stars) and start a
   session timer. When it hits zero, the app shows a full-screen "time's up" state
   and logs the session.
6. **Full completion bonus.** All of today's tasks verified = balance becomes
   unlimited until midnight.
7. **Midnight reset.** Balances zero out, tasks archive, tomorrow starts at the
   morning gate again.

Phase 1 enforcement is honor-system: the timer doesn't actually block Snapchat, it
just runs. You commit to only opening the app while a session is active. The point
is to test whether the economy changes behavior; the walls come in Phase 2.

## 3. The earning economy (starting values, tune after week 1)

| Tier | What it means | Earns |
| --- | --- | --- |
| Tier 1 | Big, hard, most important (ACT section, full problem set) | 20 min |
| Tier 2 | Medium (regular homework, annotating a chapter) | 12 min |
| Tier 3 | Small chores (upload calculator program, email a teacher) | 5 min |

Rules:

- Daily cap of 60 earned minutes total (prevents grinding small tasks into
  infinite Clash Royale).
- Minutes are a shared balance spendable on any tracked app, in 5/10/15/20 minute
  sessions.
- Unused minutes expire at midnight. No banking. This matters: banking lets you
  save up for a binge day.
- Tier assignments are suggested by Claude but you confirm them, so you can't
  quietly call everything Tier 1. Log when you override Claude's suggestion;
  review those overrides weekly.

## 4. Screens (7 total)

1. **Morning Gate.** Mic button, live transcript, text fallback, "Structure my
   day" button. Blocks all navigation until confirmed.
2. **Task Review.** Claude's structured list with tiers. Drag to reorder/re-tier,
   edit titles, delete, add. Confirm button locks the list for the day (edits
   after confirmation allowed but flagged in the weekly review, so adding easy
   tasks at 9pm is visible to future-you).
3. **Dashboard.** Minutes balance (big number), task list with status chips (todo
   / pending proof / verified / rejected), Start Session button, streak counter.
4. **Proof Capture.** In-app camera only (getUserMedia, or
   `<input type="file" accept="image/*" capture="environment">` on iOS which opens
   the camera directly). Client stamps capture time; server rejects files older
   than 2 minutes as an upload-bypass guard.
5. **Verification Result.** Verified (minutes added, small celebration), Rejected
   (Claude's reason, retake), or Follow-up (one question about the content, your
   typed answer goes back to Claude for a final verdict).
6. **Active Session.** Full-screen countdown for the chosen app. "Time's up" state
   requires a tap to acknowledge and logs the session.
7. **Weekly Review.** Every Sunday: completion rate, minutes earned vs. spent per
   app, tier overrides, late-added tasks, and a short Claude-written observation of
   your patterns with one suggested rule change for next week.

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

Row Level Security on, keyed to your user id. It's a personal app but do it
anyway; it's one toggle and it's the right habit.

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

Follow-up answers get sent back with the full prior exchange for a final
VERIFIED/REJECTED verdict.

## 7. Anti-cheat rules (Phase 1 versions)

- In-app camera only; server rejects images whose capture timestamp is more than 2
  minutes old.
- Random follow-up: even on clear VERIFIED cases, 1 in 4 verifications asks a
  content question anyway. Randomness is what makes faking expensive.
- Everything is logged, nothing is deletable: rejected proofs, tier overrides,
  tasks added after morning confirmation, and sessions all appear in the weekly
  review. Phase 1's real enforcement is visibility.

Known limits, accepted for now: you could photograph a sibling's homework, or open
Snapchat with no session running. Phase 1 doesn't try to stop that; it measures
whether you do. If week 2 shows constant cheating, that is itself the finding, and
it means Phase 2 needs to be stricter, not that the idea failed.

## 8. Build order

**Weekend 1: the economy works, no AI yet**

1. Vite + React + Tailwind scaffold, Supabase project, auth (just your account),
   tables above.
2. Morning gate with text input only; manual task entry with manual tier picking.
3. Dashboard with balance math (hardcode tier values), session timer with
   full-screen countdown and logging.
4. Midnight reset (a Supabase scheduled function, or compute "is this task from
   today" client-side, which is simpler).
5. Deploy, add to iPhone home screen as PWA, set as laptop browser homepage. Use
   it Monday.

**Weekend 2: AI + proof**

6. Edge Function `structure-tasks` + Web Speech API mic input feeding it.
7. Proof capture flow, Supabase Storage upload, Edge Function `verify-proof` with
   vision, the three verdict states.
8. Full-completion bonus and streak counter.
9. Weekly review page (static stats first; the Claude-written observation can wait
   for weekend 3).

Rule for both weekends: ship ugly. Tailwind defaults, no animations, no dark mode.
Every hour on polish in Phase 1 is an hour stolen from finding out if the loop
works.

## 9. What Phase 1 deliberately does NOT include

- Any actual blocking (that's Phase 2: iOS FamilyControls entitlement + Swift,
  laptop Cold Turkey sync).
- Video proof (photos only; video adds upload and review complexity for little
  extra verification power).
- "Scientifically optimal" session lengths (doesn't exist; you'll tune from your
  own week 1 data).
- Multiple users, sharing, or anything App Store shaped. This is a tool for one
  person: you.

## 10. How you'll know Phase 1 worked

Track for two weeks, then look at three numbers in the weekly review:

1. Task completion rate vs. a normal week (be honest about the baseline).
2. Sessions opened WITHOUT an active timer (self-reported or noticed). This is
   your cheat rate.
3. Whether the morning gate ever felt worth skipping the app entirely to avoid.

Completion up + cheat rate tolerable = build Phase 2. Cheat rate near 100% = the
design needs external walls first (parent-held Screen Time passcode), and the app
becomes the door through them.
