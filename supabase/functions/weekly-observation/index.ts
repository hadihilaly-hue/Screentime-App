import { anthropic, MODEL, parseJson, requireUser, textOf } from '../_shared/clients.ts'
import { corsHeaders, fail, json } from '../_shared/cors.ts'

const SYSTEM = `You are reviewing one week of a single student's data from an app that
converts finished schoolwork into screen-time minutes.

You get counts, not feelings. Be concrete and short. Do not congratulate.
Name the pattern you actually see in the numbers — including the unflattering
ones: tasks downgraded from Claude's suggested tier, tasks added hours after
the morning list was confirmed, rejected proofs, minutes earned but never
spent, days where nothing was completed.

Then propose exactly one rule change to try next week. It must be a specific,
mechanical change to the app's rules (a number, a cap, a cutoff), not advice
about attitude or effort.`

const SCHEMA = {
  type: 'object',
  properties: {
    observation: { type: 'string' },
    suggested_rule_change: { type: 'string' },
  },
  required: ['observation', 'suggested_rule_change'],
  additionalProperties: false,
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    await requireUser(req)
    const { stats } = await req.json()
    if (!stats) return fail('No stats supplied.')

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        { role: 'user', content: `This week's data:\n${JSON.stringify(stats, null, 2)}` },
      ],
    })

    return json(parseJson(textOf(response.content)))
  } catch (err) {
    if (err instanceof Response) return fail(await err.text(), err.status)
    console.error('weekly-observation failed', err)
    return fail('Could not generate an observation.', 502)
  }
})
