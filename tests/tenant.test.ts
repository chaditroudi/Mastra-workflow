import { describe, it, expect } from 'vitest';
import { runWithContext, requireContext, scopeFilter, stampTenant, requireRole } from '../src/middleware/tenant.js';

describe('tenant context', () => {
  it('throws when no context is bound', () => {
    expect(() => requireContext()).toThrow(/tenant/i);
  });

  it('exposes tenantId, userId and roles inside runWithContext', async () => {
    await runWithContext(
      { tenantId: 't1', userId: 'u1', roles: ['admin'], requestId: 'r1' },
      async () => {
        const ctx = requireContext();
        expect(ctx.tenantId).toBe('t1');
        expect(ctx.roles).toContain('admin');
      },
    );
  });

  it('scopeFilter injects tenantID and strips caller overrides (both casings)', async () => {
    await runWithContext(
      { tenantId: 'real', roles: [], requestId: 'r' },
      async () => {
        const f = scopeFilter({ tenantID: 'evil', tenantId: 'sneaky', name: 'X' });
        expect(f.tenantID).toBe('real');
        expect(f.tenantId).toBeUndefined();
        expect(f.name).toBe('X');
      },
    );
  });

  it('stampTenant adds tenantID to documents', async () => {
    await runWithContext(
      { tenantId: 'acme', roles: [], requestId: 'r' },
      async () => {
        const stamped = stampTenant({ name: 'M' });
        expect(stamped.tenantID).toBe('acme');
      },
    );
  });

  it('requireRole passes when role matches and throws otherwise', async () => {
    await runWithContext(
      { tenantId: 't', roles: ['analyst'], requestId: 'r' },
      async () => {
        expect(() => requireRole('analyst')).not.toThrow();
        expect(() => requireRole('admin')).toThrow();
      },
    );
  });

  it('isolates contexts across concurrent flows', async () => {
    const a = runWithContext(
      { tenantId: 'A', roles: [], requestId: 'a' },
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return requireContext().tenantId;
      },
    );
    const b = runWithContext(
      { tenantId: 'B', roles: [], requestId: 'b' },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return requireContext().tenantId;
      },
    );
    const [aa, bb] = await Promise.all([a, b]);
    expect(aa).toBe('A');
    expect(bb).toBe('B');
  });
});
