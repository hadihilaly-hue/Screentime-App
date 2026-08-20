# Where the build differs from `phase-1-spec.md`

Every item here is a deliberate decision. Nothing on Phase 1's excluded list (§9)
got built. This file is meant to be complete — if you find a divergence that
isn't listed, that's a bug in the file.

## Naming

**§ title — "EarnedTime (working title, rename it)."** Shipped as **Scrip**:
private currency issued in exchange for labour.

## Two contradictions in the spec, resolved

1. **Balance: per-app or shared?** §2.3 says the dashboard shows "your
   earned-minutes balance **per app**"; §3 says "minutes are a **shared balance**
   spendable on any tracked app". §3 wins — it states the rule, §2 describes a
   screen. The dashboard shows one number; the weekly review breaks *spending*
   down per app, which is the per-app number that's actually informative.
2. **Video proof.** §2.4 says "1 to 3 photos or a short video"; §9 explicitly
   excludes video ("photos only"). §9 wins. Photos only.

## Claude calls

- **Response format.** The spec's prompts end with "Respond ONLY with a JSON array
  / No markdown fences". That closing instruction is replaced by the API's
  constrained output (`output_config.format` with a JSON Schema) — the model can
  no longer emit a fence or a preamble, so asking it not to is wasted tokens.
  Constrained output needs an object at the root, so `structure-tasks` returns
  `{"tasks": [...]}` rather than a bare array. Fence-stripping is still applied
  defensively on parse.
- **Two rules added to the §6a structuring prompt** that are not in the spec:
  *"Do not invent tasks the student did not mention, and do not merge two separate
  subjects into one task."* In an economy where tasks are money, a hallucinated
  task is counterfeit. The merge half restates §6a's own splitting rule from the
  other direction.
- **`content_question` added to the §6b verification schema.** §7 wants 1-in-4
  verifications to ask a content question *even on a clear VERIFIED*. Getting that
  from the spec's schema alone would need a second round-trip after the verdict,
  so the verifier always supplies a spare question. When the dice come up, the
  VERIFIED verdict is converted to FOLLOW_UP using it, and the attempt is logged
  with `forced_follow_up = true` so the weekly review can separate spot checks
  from real doubts.
- **Model.** `claude-sonnet-4-6` per §1, overridable with the `ANTHROPIC_MODEL`
  secret without a code change.

## Screens

- **Task Review re-ordering.** §4.2 says "drag to reorder/re-tier". HTML5 drag is
  implemented and works on a laptop, but it is unreliable on iOS Safari, so each
  row also has ▲▼ buttons and a three-way tier selector. Re-tiering is a tap on
  the tier you want rather than a drag between groups.
- **A sign-in screen exists** and isn't in the list of 7. Supabase auth needs one.
  §9 says this is a tool for one person, so **registration is off by default** —
  the "create account" path only appears when `VITE_ALLOW_SIGNUP=true`. Turn it on
  once, make your account, turn it off, and disable signups in the Supabase
  dashboard too.
- **Weekly review is always reachable**, not gated to Sundays; §4.7's "every
  Sunday" cadence is a card on the dashboard that only appears on a Sunday.
- **The dark palette.** §8 says "no animations, no dark mode". There are no
  animations and no theme switcher — but there is exactly one palette and it is
  dark. A single hard-coded palette is the ship-ugly option; building a light one
  as well is the polish §8 is warning against.

## Data model

The spec's four tables are all present with the columns it lists. Added:

| Addition | Why |
| --- | --- |
| `app_config` table | §3 says "tune after week 1". Tier values, the daily cap and the follow-up rate live in one row so tuning is an `UPDATE`, not a redeploy. |
| `verification_attempts` table | §7 requires rejected proofs to still be visible in the weekly review. A retake overwrites `tasks.status`, so rejections need their own append-only table. |
| `cheat_reports` table | §10's second success metric is self-reported opens with no session running. It needed somewhere to live. |
| `tasks.proof_hint`, `.self_report_only`, `.follow_up_question`, `.follow_up_answer`, `.minutes_awarded`, `.position` | Required by §6a's `proof_hint`, §6b's follow-up round-trip, and §4.2's ordering. |
| `balances.minutes_spent_total` | §7 wants "earned vs. spent per app" in the weekly review. |
| `sessions.from_bonus`, `.acknowledged` | §2.6 bonus sessions shouldn't debit; §4.6 requires the acknowledging tap to be logged. |
| `daily_state.raw_transcript` | Keeps the morning ramble next to the list it produced, so you can see later what you actually said. |

## Credit that isn't a photo verification

Three things can credit minutes, and the weekly review distinguishes all three:

| Path | Logged verdict | Why it exists |
| --- | --- | --- |
| `credit_verified_task` | `VERIFIED` | Claude looked at photos and passed them. Service-role only. |
| `credit_self_reported_task` | `MANUAL` | §6a mandates a "self-report, no photo needed" tier for tasks that can't be photographed. Service-role only; `verify-proof` checks `self_report_only` first. |
| `credit_manual_task` | `MANUAL` | The client *can* call this one. It exists so the app works during Weekend 1 (§8, "the economy works, no AI yet") and when the Anthropic API is down. |

All three set `tasks.status = 'verified'`, because §5 fixes the status enum at
`todo | pending | verified | rejected` and there is no fourth value to use. So the
weekly review shows the completion rate **and**, whenever they differ, the share
that was actually verified from a photo — plus a count of credits granted without
anyone looking at evidence.

## Who may write which columns

§3's override log and §6a's "no photo needed" exemption are only worth anything
if the browser can't author them. Two paths create tasks:

- `create_structured_tasks` — service-role only, called by `structure-tasks` with
  what Claude returned. The only path that may set `claude_suggested_tier`,
  `proof_hint` or `self_report_only`.
- a plain client `INSERT` — a task you typed yourself. A trigger strips those
  three columns unconditionally, so a hand-added task is always self-tiered and
  always needs a photo.

Afterwards the client holds a column-level `UPDATE` grant on `title`, `tier` and
`position` only. It cannot mark a task verified, award itself minutes, clear the
late-addition flag, or rewrite what Claude suggested.

## The "Skip AI" route

§8.2 requires manual task entry with manual tier picking for Weekend 1, and the
morning gate keeps that route permanently — it is also what you fall back to when
`structure-tasks` errors. §3's "you can't quietly call everything Tier 1" is
enforced by *visibility*, not by removing the route: a hand-added task stores
`claude_suggested_tier = null` (there was no suggestion to override), and the
weekly review counts those separately as "tasks you tiered yourself".

## Build order

§8 splits the work across two weekends and defers one item — §8.9's Claude-written
weekly observation — to a third. This build ships all of it, because the request
was for Phase 1 complete, and §4.7 lists the observation as part of the Weekly
Review screen. Nothing from §9's exclusion list is included, and the Weekend-1
path still works standalone: with no Edge Functions deployed, the gate's "Skip AI"
route, manual tier picking and `credit_manual_task` cover the whole loop.

## Midnight reset

§8.4 offers a scheduled function or client-side date keying, and names the latter
as simpler. There is still no scheduler — every row is keyed to a calendar date
and tomorrow is simply a different key — but the *date itself* is computed
server-side from `now()` and the IANA timezone stored on your `app_config` row,
not taken from whatever the device claims. `confirm_day`, `start_session`, task
insertion and `_credit_task` all reject any date that isn't your today.

An earlier version trusted the client's date within a ±1 day window (wide enough
for any real timezone). That was enough to bank: create a task dated tomorrow,
credit it manually, and tomorrow started with a loaded balance — the exact thing
§3 singles out ("banking lets you save up for a binge day").

**Residual, stated plainly.** The timezone comes from your browser and the app
writes it back whenever your device's zone changes, so someone determined can
still change their device timezone, pre-load a day, and change it back. That is a
deliberate two-step act, not a clock nudge, and it lands squarely in §7's list of
things Phase 1 measures rather than prevents.

## Photo freshness has one hole

§7's guard rejects a capture stamp older than 2 minutes. On the live-camera path
the stamp is the moment of capture and is exact. On the file-input fallback it is
the file's own mtime — so picking last Tuesday's photo out of the library fails,
which is the point. But if a file reports no mtime at all (`lastModified === 0`),
`src/components/CameraCapture.tsx` falls back to "now", because a freshly taken
photo on such a browser would otherwise be unsubmittable. No current mobile
browser does this; it is a hole all the same.
