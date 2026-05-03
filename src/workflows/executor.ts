import type { Plan, PlanStep, StepResult, AgentName } from '../schemas/ir.js';
import { AppError, ValidationError } from '../utils/errors.js';

export type AgentRunner = (agent: AgentName, action: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Execute a plan with dependency-aware scheduling. Pure: takes a runner
 * function so the same engine is used in production and in tests with stubs.
 *
 * Scheduling rules:
 *   - A step is "ready" when every ID in its `dependsOn` has produced an OK result.
 *   - Within a wave, steps with `parallelizable=true` run concurrently via Promise.all.
 *   - Non-parallelizable steps run sequentially; if one fails, we stop running
 *     more *serial* steps in this wave. Dependent steps in later waves get
 *     marked DEPENDENCY_FAILED on the next iteration.
 *   - Independent branches keep running even if a sibling failed — partial
 *     results can still be useful (e.g. a chart may render even if a separate
 *     write failed).
 */
export async function executePlan(plan: Plan, runner: AgentRunner): Promise<StepResult[]> {
  const results = new Map<number, StepResult>();
  const remaining = new Set(plan.steps.map((s) => s.id));

  while (remaining.size > 0) {
    const ready = plan.steps.filter(
      (s) => remaining.has(s.id) && (s.dependsOn ?? []).every((d) => results.get(d)?.ok),
    );

    if (ready.length === 0) {
      // No step can run: either a cycle or upstream failure. Mark the rest.
      for (const id of remaining) {
        const step = plan.steps.find((s) => s.id === id)!;
        results.set(id, {
          stepId: id,
          agent: step.agent,
          action: step.action,
          ok: false,
          error: { code: 'DEPENDENCY_FAILED', message: 'A prerequisite step failed or is unreachable' },
          durationMs: 0,
        });
      }
      break;
    }

    const parallel = ready.filter((s) => s.parallelizable);
    const serial = ready.filter((s) => !s.parallelizable);

    if (parallel.length > 0) {
      const wave = await Promise.all(parallel.map((s) => executeStep(s, results, runner)));
      for (const r of wave) {
        results.set(r.stepId, r);
        remaining.delete(r.stepId);
      }
    }

    for (const s of serial) {
      const r = await executeStep(s, results, runner);
      results.set(r.stepId, r);
      remaining.delete(r.stepId);
      if (!r.ok) break;
    }
  }

  return plan.steps.map((s) => results.get(s.id)!).filter(Boolean);
}

async function executeStep(
  step: PlanStep,
  prior: Map<number, StepResult>,
  runner: AgentRunner,
): Promise<StepResult> {
  const start = Date.now();
  try {
    const resolvedArgs = resolvePlaceholders(step.args, prior);
    const output = await runner(step.agent, step.action, resolvedArgs);
    return {
      stepId: step.id,
      agent: step.agent,
      action: step.action,
      ok: true,
      output,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e =
      err instanceof AppError
        ? err
        : new AppError({ code: 'AGENT_FAILURE', message: (err as Error)?.message ?? 'agent failure' });
    return {
      stepId: step.id,
      agent: step.agent,
      action: step.action,
      ok: false,
      error: { code: e.code, message: e.message },
      durationMs: Date.now() - start,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Placeholder resolution                                              */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /^\$step:(\d+)\.(.+)$/;

/**
 * Replace any "$step:N.path" string token (when it's the *entire* string) with
 * the value from step N's output. Type is preserved — an inserted ID stays a
 * string, an array result stays an array, etc.
 */
export function resolvePlaceholders(
  args: Record<string, unknown>,
  prior: Map<number, StepResult>,
): Record<string, unknown> {
  return walk(args, prior) as Record<string, unknown>;
}

function walk(node: unknown, prior: Map<number, StepResult>): unknown {
  if (typeof node === 'string') {
    const m = node.match(PLACEHOLDER);
    if (!m) return node;
    const stepId = Number(m[1]);
    const path = m[2];
    const r = prior.get(stepId);
    if (!r || !r.ok) {
      throw new ValidationError(`Placeholder references missing/failed step ${stepId}`);
    }
    return getPath(r.output, path);
  }
  if (Array.isArray(node)) return node.map((n) => walk(n, prior));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v, prior);
    return out;
  }
  return node;
}

export function getPath(obj: unknown, path: string): unknown {
  // Supports a.b.c, a[0].b, a.0.b
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* Final answer rendering                                              */
/* ------------------------------------------------------------------ */

export function renderFinal(plan: Plan, results: StepResult[]): string {
  const map = new Map(results.map((r) => [r.stepId, r]));
  if (plan.finalTemplate) {
    return plan.finalTemplate.replace(/\$step:(\d+)\.([^\s)]+)/g, (_m, id, path) => {
      const r = map.get(Number(id));
      if (!r?.ok) return `<step ${id} failed>`;
      const v = getPath(r.output, path);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  const lines = results.map((r) =>
    r.ok
      ? `✓ step ${r.stepId} (${r.agent}.${r.action}) — ${r.durationMs}ms`
      : `✗ step ${r.stepId} (${r.agent}.${r.action}) — ${r.error?.message}`,
  );
  return [plan.summary, '', ...lines].join('\n');
}
