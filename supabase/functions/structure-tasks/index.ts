import { anthropic, MODEL, parseJson, requireUser, textOf } from '../_shared/clients.ts'
import { corsHeaders, fail, json } from '../_shared/cors.ts'

const SYSTEM = `You convert a student's spoken morning ramble into a structured task list.
Rules:
- Split into discrete, verifiable tasks. "Study for bio and math" becomes two tasks.
- Each task gets: title (short, concrete), tier (1, 2, or 3), and proof_hint
  (one sentence describing what photo evidence of completion would look like).
- Tier 1 = major academic work (test prep sections, essays, problem sets).
  Tier 2 = standard homework or focused study blocks.
  Tier 3 = quick logistics (emails, uploads, packing).
- If a task is too vague to verify with a photo ("think about my project"),
  keep it but set tier 3 and proof_hint to "self-report, no photo needed".
- Do not invent tasks the student did not mention, and do not merge two
  separate subjects into one task.`

const SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tier: { type: 'integer', enum: [1, 2, 3] },
          proof_hint: { type: 'string' },
        },
        required: ['title', 'tier', 'proof_hint'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
}

type StructuredTask = { title: string; tier: 1 | 2 | 3; proof_hint: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    await requireUser(req)

    const { transcript } = await req.json()
    if (typeof transcript !== 'string' || transcript.trim().length < 3) {
      return fail('Give me a sentence or two about your day first.')
    }
    if (transcript.length > 8000) return fail('That transcript is too long.')

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: transcript }],
    })

    const { tasks } = parseJson<{ tasks: StructuredTask[] }>(textOf(response.content))
    if (!tasks?.length) {
      return fail("Couldn't find any tasks in that. Try naming them one by one.")
    }
    return json({
      tasks: tasks.map((t) => ({
        title: t.title.slice(0, 200),
        tier: t.tier,
        proof_hint: t.proof_hint,
        self_report_only: /self-?report/i.test(t.proof_hint),
      })),
    })
  } catch (err) {
    if (err instanceof Response) return fail(await err.text(), err.status)
    console.error('structure-tasks failed', err)
    return fail('Could not structure that. Type the list in manually.', 502)
  }
})
