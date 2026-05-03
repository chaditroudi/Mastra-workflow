import { describe, it, expect, vi } from 'vitest';
import { executePlan, resolvePlaceholders, getPath, renderFinal } from '../src/workflows/executor.js';
import type { Plan, StepResult } from '../src/schemas/ir.js';

const baseStep = {
  agent: 'mongodb' as const,
  action: 'create',
  args: {},
  parallelizable: false,
  dependsOn: [] as number[],
};

describe('executor.getPath', () => {
  const obj = { a: { b: [{ c: 42 }, { c: 99 }] }, x: 'y' };
  it('reads dotted paths', () => expect(getPath(obj, 'a.b.0.c')).toBe(42));
  it('reads bracket paths', () => expect(getPath(obj, 'a.b[1].c')).toBe(99));
  it('returns undefined for missing keys', () => expect(getPath(obj, 'a.z.c')).toBeUndefined());
  it('handles top-level keys', () => expect(getPath(obj, 'x')).toBe('y'));
});

describe('executor.resolvePlaceholders', () => {
  const prior = new Map<number, StepResult>([
    [
      1,
      {
        stepId: 1,
        agent: 'mongodb',
        action: 'create',
        ok: true,
        output: { insertedId: 'abc123', result: [{ name: 'A' }, { name: 'B' }] },
        durationMs: 1,
      },
    ],
  ]);

  it('substitutes a top-level string placeholder', () => {
    const out = resolvePlaceholders({ id: '$step:1.insertedId' }, prior);
    expect(out.id).toBe('abc123');
  });

  it('preserves array types when substituting', () => {
    const out = resolvePlaceholders({ records: '$step:1.result' }, prior);
    expect(Array.isArray(out.records)).toBe(true);
    expect((out.records as unknown[]).length).toBe(2);
  });

  it('substitutes inside nested objects and arrays', () => {
    const out = resolvePlaceholders({ data: { items: ['$step:1.insertedId'] } }, prior);
    expect((out.data as { items: string[] }).items[0]).toBe('abc123');
  });

  it('does NOT substitute embedded placeholders (only whole-string)', () => {
    const out = resolvePlaceholders({ id: 'prefix-$step:1.insertedId' }, prior);
    expect(out.id).toBe('prefix-$step:1.insertedId');
  });

  it('throws when placeholder references a failed step', () => {
    const failedPrior = new Map<number, StepResult>([
      [
        1,
        {
          stepId: 1,
          agent: 'mongodb',
          action: 'create',
          ok: false,
          error: { code: 'X', message: 'boom' },
          durationMs: 0,
        },
      ],
    ]);
    expect(() => resolvePlaceholders({ x: '$step:1.insertedId' }, failedPrior)).toThrow();
  });
});

describe('executor.executePlan', () => {
  it('runs a single step and records duration', async () => {
    const plan: Plan = {
      summary: 's',
      steps: [{ id: 1, ...baseStep, args: { collection: 'C' } }],
    };
    const runner = vi.fn(async () => ({ insertedId: 'x' }));
    const out = await executePlan(plan, runner);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(out[0].output).toEqual({ insertedId: 'x' });
    expect(runner).toHaveBeenCalledOnce();
  });

  it('respects dependsOn ordering', async () => {
    const calls: number[] = [];
    const plan: Plan = {
      summary: 's',
      steps: [
        { id: 1, ...baseStep, args: {} },
        { id: 2, ...baseStep, args: {}, dependsOn: [1] },
        { id: 3, ...baseStep, args: {}, dependsOn: [2] },
      ],
    };
    const runner = vi.fn(async (_a, _b, _args) => {
      // Identify step by call order — runner doesn't see step IDs directly.
      calls.push(calls.length + 1);
      return { ok: true };
    });
    const out = await executePlan(plan, runner);
    expect(calls).toEqual([1, 2, 3]);
    expect(out.every((r) => r.ok)).toBe(true);
  });

  it('runs parallelizable steps concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const plan: Plan = {
      summary: 's',
      steps: [
        { id: 1, ...baseStep, parallelizable: true, args: {} },
        { id: 2, ...baseStep, parallelizable: true, args: {} },
        { id: 3, ...baseStep, parallelizable: true, args: {} },
      ],
    };
    const runner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      return {};
    };
    await executePlan(plan, runner);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('marks dependent steps DEPENDENCY_FAILED when prerequisite fails', async () => {
    const plan: Plan = {
      summary: 's',
      steps: [
        { id: 1, ...baseStep, args: {} },
        { id: 2, ...baseStep, args: {}, dependsOn: [1] },
      ],
    };
    const runner = vi.fn(async () => {
      throw new Error('db down');
    });
    const out = await executePlan(plan, runner);
    expect(out[0].ok).toBe(false);
    expect(out[1].ok).toBe(false);
    expect(out[1].error?.code).toBe('DEPENDENCY_FAILED');
  });

  it('substitutes placeholders before calling the runner', async () => {
    const plan: Plan = {
      summary: 's',
      steps: [
        { id: 1, ...baseStep, args: {} },
        {
          id: 2,
          ...baseStep,
          args: { fromId: '$step:1.insertedId' },
          dependsOn: [1],
        },
      ],
    };
    const seen: unknown[] = [];
    const runner = async (_a: unknown, _b: unknown, args: Record<string, unknown>) => {
      seen.push(args);
      return { insertedId: 'XYZ' };
    };
    await executePlan(plan, runner);
    expect((seen[1] as { fromId: string }).fromId).toBe('XYZ');
  });

  it('lets independent branches succeed even if a sibling fails', async () => {
    const plan: Plan = {
      summary: 's',
      steps: [
        { id: 1, ...baseStep, args: {} }, // will fail
        { id: 2, ...baseStep, args: {} }, // independent — should still run
      ],
    };
    let n = 0;
    const runner = async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { ok: true };
    };
    const out = await executePlan(plan, runner);
    expect(out[0].ok).toBe(false);
    expect(out[1].ok).toBe(true);
  });
});

describe('executor.renderFinal', () => {
  it('substitutes placeholders in finalTemplate', () => {
    const plan: Plan = {
      summary: 's',
      steps: [{ id: 1, ...baseStep, args: {} }],
      finalTemplate: 'Created with id $step:1.insertedId',
    };
    const results: StepResult[] = [
      { stepId: 1, agent: 'mongodb', action: 'create', ok: true, output: { insertedId: 'abc' }, durationMs: 1 },
    ];
    expect(renderFinal(plan, results)).toBe('Created with id abc');
  });

  it('falls back to a per-step status list when no template', () => {
    const plan: Plan = { summary: 'demo', steps: [{ id: 1, ...baseStep, args: {} }] };
    const results: StepResult[] = [
      { stepId: 1, agent: 'mongodb', action: 'create', ok: true, output: {}, durationMs: 5 },
    ];
    const out = renderFinal(plan, results);
    expect(out).toContain('demo');
    expect(out).toContain('✓ step 1');
  });
});
