import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../src/schemas/ir.js';

describe('PlanSchema', () => {
  it('accepts a minimal valid plan', () => {
    const r = PlanSchema.safeParse({
      summary: 'Create a model',
      steps: [
        {
          id: 1,
          agent: 'mongodb',
          action: 'create',
          args: { collection: 'Models', data: { name: 'M1' } },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown agents', () => {
    const r = PlanSchema.safeParse({
      summary: 'x',
      steps: [{ id: 1, agent: 'sql', action: 'create', args: {} }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty step list', () => {
    const r = PlanSchema.safeParse({ summary: 'x', steps: [] });
    expect(r.success).toBe(false);
  });

  it('defaults dependsOn and parallelizable', () => {
    const r = PlanSchema.parse({
      summary: 'x',
      steps: [{ id: 1, agent: 'search', action: 'find', args: { query: 'q' } }],
    });
    expect(r.steps[0].dependsOn).toEqual([]);
    expect(r.steps[0].parallelizable).toBe(false);
  });
});
