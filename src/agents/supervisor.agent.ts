import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';

const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

/**
 * The Supervisor. Two modes:
 *
 *   1. Planning mode (orchestrator.ts) — call .generate() with `output: PlanSchema`
 *      to produce an IR plan. The orchestrator then executes the plan
 *      deterministically, dispatching to mongoService / searchService / chartService.
 *
 *   2. Conversational fallback — call .generate() / .stream() without an
 *      output schema for free-form replies. Useful for prompts that don't
 *      decompose into a plan (e.g. "what does this dataset look like?").
 *
 * Sub-agents are NOT registered on this agent because Mastra's AgentConfig has
 * no `agents` field; instead they are registered on the Mastra instance
 * (config/mastra.ts) and the orchestrator does the routing using the IR plan.
 */
export const supervisorAgent = new Agent({
  name: 'supervisor',
  description: 'Top-level coordinator. Translates natural-language requests into structured plans.',
  instructions: `
You coordinate database operations, search, chart generation, and email delivery across four specialized
subagents that the system will invoke based on your plan:
- mongodb — for any read/write/link/aggregate against the tenant's MongoDB collections.
- search — for finding relevant data internally or externally.
- chart — for producing Chart.js configs from given labels + datasets.
- email — for sending reports or notifications. REQUIRES an admin or operator role; do not include
  email steps in plans for users without this privilege. When attaching a chart from a previous step,
  reference its imageUrl via $step:N.imageUrl.

When asked to produce a PLAN, output a JSON object that matches the provided schema. A good plan:

  - Names a specific collection for every mongodb step.
  - Uses action="create" for inserts, "query" for reads, "link" for relationships, "aggregate" for grouping/sums.
  - Uses placeholders of the form "$step:<id>.<json-pointer>" inside later steps' args to reference earlier outputs.
    Example: "$step:1.insertedId" or "$step:2.result[0].revenue".
  - Sets dependsOn to the IDs of any prior steps whose output this step references.
  - Marks parallelizable=true ONLY when a step has no inter-step dependencies and is read-only.
  - Includes a short \`rationale\` for each step (one sentence).
  - Includes a \`finalTemplate\` that summarizes the result, again using $step placeholders.

Never include tenantID in filters — the system injects it automatically.
Never invent IDs that don't come from a prior step's output.
`.trim(),
  model: openai(MODEL),
});
