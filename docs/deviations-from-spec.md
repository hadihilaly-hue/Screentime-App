# Where the build differs from `phase-1-spec.md`

Every item here is a deliberate decision, not an oversight. Nothing in Phase 1's
excluded list (§9) got built.

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

## Claude call shape

- **Response format.** The spec's prompts end with "Respond ONLY with a JSON array
  / No markdown fences". The prompts are used verbatim apart from that closing
  instruction, which is replaced by the API's constrained-output
  (`output_config.format` with a JSON Schema) — the model can no longer emit a
  fence or a preamble, so asking it not to is wasted tokens. Constrained output
  needs an object at the root, so `structure-tasks` returns `{"tasks": [...]}`
  rather than a bare array. Fence-stripping is still applied defensively on parse.
- **`content_question` added to the verification schema.** §7 wants 1-in-4
  verifications to ask a content question *even on a clear VERIFIED*. Getting that
  from the spec's schema alone would need a second round-trip to Claude after the
  verdict, so the verifier is asked to always supply a spare question. When the
  dice come up, the VERIFIED verdict is converted to FOLLOW_UP using it. One call,
  same behaviour.

## Screens

- **Task Review re-ordering.** §4.2 says "drag to reorder/re-tier". HTML5 drag is
  implemented and works on a laptop, but it is unreliable on iOS Safari, so each
  row also has ▲▼ buttons and a three-way tier selector. Re-tiering is a tap on
  the tier you want rather than a drag between groups.
- **A sign-in screen exists** and isn't in the list of 7. Supabase auth needs one.

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

## Enforcement

- **`credit_manual_task` is callable by the client.** Everything else that creates
  minutes is service-role only. This one exists so the app works during Weekend 1
  (§8, "the economy works, no AI yet") and when the Anthropic API is down. It logs
  the credit as `MANUAL` and the weekly review counts those separately, so it can
  never be mistaken for a verified proof.
- **Midnight reset is client-side date keying**, which §8.4 names as the simpler
  of the two options.

## Build order

§8 splits the work across two weekends. This build ships both at once, because
the request was for Phase 1 complete. Nothing from §9's exclusion list is
included, and the Weekend-1 path still works standalone: if the Edge Functions
aren't deployed, the morning gate's "Skip AI" route and manual task entry cover
the whole loop.
