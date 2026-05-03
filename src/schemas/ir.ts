import { z } from 'zod';

/**
 * Intermediate Representation (IR) for a workflow plan.
 *
 * The Supervisor uses Mastra's structuredOutput to emit a plan matching this
 * schema. Each step targets one of the registered subagents and carries the
 * arguments that subagent expects.
 *
 * Steps may reference outputs from earlier steps via `$step:<index>.<path>`
 * placeholders inside string fields of `args`. The orchestrator resolves these
 * placeholders before calling the agent.
 */

export const AgentNameSchema = z.enum(['mongodb', 'search', 'chart', 'email']);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const PlanStepSchema = z.object({
  /** 1-based index — useful for both placeholders and logs. */
  id: z.number().int().positive(),
  agent: AgentNameSchema,
  /** Action verb meaningful to the target agent (e.g. "create", "query", "find", "render"). */
  action: z.string().min(1),
  /** Free-form, agent-specific arguments. Validated again by the agent's own schema. */
  args: z.record(z.string(), z.unknown()),
  /** Optional human-readable rationale, surfaced in logs / final answer. */
  rationale: z.string().optional(),
  /** If true, the orchestrator may execute this step in parallel with siblings. */
  parallelizable: z.boolean().optional().default(false),
  /** Step IDs that must complete before this one runs. */
  dependsOn: z.array(z.number().int().positive()).optional().default([]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  /** A short summary the Supervisor will read back to the user. */
  summary: z.string(),
  steps: z.array(PlanStepSchema).min(1),
  /** Optional final-answer template referencing step outputs. */
  finalTemplate: z.string().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Result of executing a single step. */
export interface StepResult {
  stepId: number;
  agent: AgentName;
  action: string;
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
}
