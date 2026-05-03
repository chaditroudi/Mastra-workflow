import { supervisorAgent } from '../agents/supervisor.agent.js';
import { mongoService } from '../services/mongo.service.js';
import { searchService } from '../services/search.service.js';
import { chartService } from '../services/chart.service.js';
import { emailService } from '../services/email.service.js';
import { PlanSchema, type Plan, type StepResult, type AgentName } from '../schemas/ir.js';
import {
  MongoToolInputSchema,
  SearchToolInputSchema,
  ChartToolInputSchema,
  EmailToolInputSchema,
} from '../schemas/agents.js';
import { PlanParseError, ValidationError, AppError } from '../utils/errors.js';
import { withContext } from '../utils/logger.js';
import { requireContext } from '../middleware/tenant.js';
import { executePlan, renderFinal, type AgentRunner } from './executor.js';

export interface OrchestrateInput {
  prompt: string;
  /** Optional pre-built plan to skip the planning phase (used in tests/preview). */
  plan?: Plan;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface OrchestrateOutput {
  plan: Plan;
  results: StepResult[];
  answer: string;
  charts: { stepId: number; config: unknown; imageUrl?: string }[];
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateOutput> {
  const ctx = requireContext();
  const log = withContext({ tenantId: ctx.tenantId, requestId: ctx.requestId, agent: 'orchestrator' });

  const plan = input.plan ?? (await planFromPrompt(input.prompt, input.history));
  log.info({ steps: plan.steps.length, summary: plan.summary }, 'plan ready');

  const results = await executePlan(plan, productionRunner);

  const charts: OrchestrateOutput['charts'] = [];
  for (const r of results) {
    if (r.agent === 'chart' && r.ok && r.output) {
      const out = r.output as { chartConfig?: unknown; imageUrl?: string };
      if (out.chartConfig) {
        charts.push({ stepId: r.stepId, config: out.chartConfig, imageUrl: out.imageUrl });
      }
    }
  }

  return { plan, results, answer: renderFinal(plan, results), charts };
}

/* ------------------------------------------------------------------ */
/* Planning: NL → IR via supervisor's structured output                */
/* ------------------------------------------------------------------ */

async function planFromPrompt(prompt: string, history?: OrchestrateInput['history']): Promise<Plan> {
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

  // With `output: schema`, Mastra returns a GenerateObjectResult whose `.object`
  // is the parsed value. We still validate again defensively in case of SDK drift.
  const candidate =
    (res as { object?: unknown }).object ?? safeJsonParse((res as { text?: string }).text ?? '');
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

/* ------------------------------------------------------------------ */
/* Production agent runner — validates args, calls real services       */
/* ------------------------------------------------------------------ */

const productionRunner: AgentRunner = async (agent: AgentName, action, args) => {
  switch (agent) {
    case 'mongodb': {
      const validated = MongoToolInputSchema.safeParse({ action, ...args });
      if (!validated.success) {
        throw new ValidationError(`Invalid mongo args: ${validated.error.message}`, validated.error.flatten());
      }
      const out = await mongoService.execute(validated.data);
      if (!out.success) throw new AppError({ code: 'AGENT_FAILURE', message: out.error ?? 'mongo failed' });
      return out;
    }
    case 'search': {
      const validated = SearchToolInputSchema.safeParse(args);
      if (!validated.success) {
        throw new ValidationError(`Invalid search args: ${validated.error.message}`, validated.error.flatten());
      }
      return searchService.execute(validated.data);
    }
    case 'chart': {
      const validated = ChartToolInputSchema.safeParse(args);
      if (!validated.success) {
        throw new ValidationError(`Invalid chart args: ${validated.error.message}`, validated.error.flatten());
      }
      return chartService.execute(validated.data);
    }
    case 'email': {
      const validated = EmailToolInputSchema.safeParse(args);
      if (!validated.success) {
        throw new ValidationError(`Invalid email args: ${validated.error.message}`, validated.error.flatten());
      }
      const out = await emailService.execute(validated.data);
      if (!out.success) throw new AppError({ code: 'AGENT_FAILURE', message: out.error ?? 'email failed' });
      return out;
    }
    default: {
      const _exh: never = agent;
      throw new ValidationError(`Unknown agent: ${String(_exh)}`);
    }
  }
};
