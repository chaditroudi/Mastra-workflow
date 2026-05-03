import { supervisorAgent } from '../agents/supervisor.agent.js';
import { PlanSchema, type Plan } from '../schemas/ir.js';
import { PlanParseError } from '../utils/errors.js';

/**
 * Planning-only entry point. Mirrors the planner inside `orchestrate` but is
 * exposed so the HTTP API can return a plan to the user for approval before
 * any side-effects run.
 */
export async function planOnly(
  prompt: string,
  history?: { role: 'user' | 'assistant'; content: string }[],
): Promise<Plan> {
  const messages = [
    ...(history ?? []),
    {
      role: 'user' as const,
      content:
        'Produce a JSON plan for the following request. Output ONLY the JSON object, no prose.\n\n' +
        `Request: ${prompt}`,
    },
  ];
  const res = await supervisorAgent.generate(messages, { output: PlanSchema });
  const candidate =
    (res as { object?: unknown }).object ??
    safeJsonParse((res as { text?: string }).text ?? '');
  const parsed = PlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanParseError('Supervisor failed to produce a valid plan', parsed.error.flatten());
  }
  return parsed.data;
}

function safeJsonParse(s: string): unknown {
  const cleaned = s.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}
