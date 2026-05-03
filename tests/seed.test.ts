import { describe, it, expect } from 'vitest';
import { SEEDS } from '../src/seed.js';

describe('seed data', () => {
  it('has at least two tenants', () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(2);
  });

  it('has unique tenant IDs', () => {
    const ids = SEEDS.map((s) => s.tenantId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every link references models and datasets that actually exist for that tenant', () => {
    for (const seed of SEEDS) {
      const modelNames = new Set(seed.models.map((m) => m.name));
      const datasetNames = new Set(seed.datasets.map((d) => d.name));
      for (const link of seed.links) {
        expect(modelNames.has(link.model), `tenant ${seed.tenantId} link refs unknown model ${link.model}`).toBe(true);
        expect(datasetNames.has(link.dataset), `tenant ${seed.tenantId} link refs unknown dataset ${link.dataset}`).toBe(true);
      }
    }
  });

  it('every model has at least one input column', () => {
    for (const seed of SEEDS) {
      for (const m of seed.models) {
        expect(m.inputs.length, `${seed.tenantId}/${m.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('sales rows have positive revenue', () => {
    for (const seed of SEEDS) {
      for (const row of seed.sales) {
        expect(row.revenue).toBeGreaterThan(0);
      }
    }
  });

  it('the contoso sentinel value (9999) is not present in any other tenant', () => {
    const other = SEEDS.filter((s) => s.tenantId !== 'contoso');
    for (const seed of other) {
      const has = seed.sales.some((r) => r.revenue === 9999);
      expect(has, `${seed.tenantId} should not contain the sentinel`).toBe(false);
    }
  });
});
