import { describe, it, expect } from 'vitest';
import { runWithContext } from '../src/middleware/tenant.js';
import { emailService } from '../src/services/email.service.js';
import { TenantForbiddenError } from '../src/utils/errors.js';

/**
 * The email service has no DB or LLM dependency — it's a pure unit-testable
 * surface. The provider URL is unset in tests, so it falls into the stub
 * branch that returns { success: true, stubbed: true } for authorized callers
 * and throws TenantForbiddenError for unauthorized ones.
 */

const ctx = (roles: string[]) => ({ tenantId: 'acme', roles, requestId: 'r' });

describe('emailService RBAC', () => {
  it('allows admin to send', async () => {
    await runWithContext(ctx(['admin']), async () => {
      const r = await emailService.execute({ to: 'test@example.com', subject: 'hi', body: 'hello' });
      expect(r.success).toBe(true);
      expect(r.stubbed).toBe(true);
      expect(r.messageId).toMatch(/^stub-/);
    });
  });

  it('allows operator to send', async () => {
    await runWithContext(ctx(['operator']), async () => {
      const r = await emailService.execute({ to: 'test@example.com', subject: 'hi', body: 'hello' });
      expect(r.success).toBe(true);
    });
  });

  it('allows a user with multiple roles where one matches', async () => {
    await runWithContext(ctx(['viewer', 'operator']), async () => {
      const r = await emailService.execute({ to: 'test@example.com', subject: 'hi', body: 'hello' });
      expect(r.success).toBe(true);
    });
  });

  it('rejects a viewer attempting to send', async () => {
    await runWithContext(ctx(['viewer']), async () => {
      await expect(
        emailService.execute({ to: 'test@example.com', subject: 'hi', body: 'hello' }),
      ).rejects.toBeInstanceOf(TenantForbiddenError);
    });
  });

  it('rejects a user with no roles at all', async () => {
    await runWithContext(ctx([]), async () => {
      await expect(
        emailService.execute({ to: 'test@example.com', subject: 'hi', body: 'hello' }),
      ).rejects.toBeInstanceOf(TenantForbiddenError);
    });
  });
});
