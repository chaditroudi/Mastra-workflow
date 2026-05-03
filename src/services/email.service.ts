import { randomUUID } from 'node:crypto';
import { requireContext, requireRole } from '../middleware/tenant.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { AppError } from '../utils/errors.js';
import type { EmailToolInput, EmailToolOutput } from '../schemas/agents.js';

/**
 * Email service. The default backend is a stub that just logs and returns a
 * synthetic message id — this lets the demo run without external creds. Wire
 * in a real provider (Resend / SES / SMTP) by setting EMAIL_PROVIDER_URL +
 * EMAIL_PROVIDER_KEY and the HTTP client below will switch over automatically.
 *
 * Sending email is a privileged action — we require the "admin" or "operator"
 * role. This is the kind of guardrail an LLM-driven plan should never be able
 * to bypass.
 */
export const emailService = {
  async execute(input: EmailToolInput): Promise<EmailToolOutput> {
    requireRole('admin', 'operator');
    const ctx = requireContext();
    const log = logger.child({ tenantId: ctx.tenantId, agent: 'email' });

    const url = process.env.EMAIL_PROVIDER_URL;
    if (!url) {
      const id = `stub-${randomUUID()}`;
      log.info(
        { to: input.to, subject: input.subject, bodyLen: input.body.length, attachments: input.attachments?.length ?? 0 },
        'email stubbed (no EMAIL_PROVIDER_URL configured)',
      );
      return { success: true, messageId: id, stubbed: true };
    }

    try {
      return await withRetry(
        async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(process.env.EMAIL_PROVIDER_KEY
                ? { authorization: `Bearer ${process.env.EMAIL_PROVIDER_KEY}` }
                : {}),
            },
            body: JSON.stringify({
              to: input.to,
              subject: input.subject,
              body: input.body,
              attachments: input.attachments ?? [],
              replyTo: input.replyTo,
              tenantId: ctx.tenantId,
            }),
          });
          if (!res.ok) {
            throw new AppError({
              code: 'UPSTREAM_FAILURE',
              message: `Email provider returned ${res.status}`,
              retriable: res.status >= 500,
            });
          }
          const json = (await res.json()) as { id?: string; messageId?: string };
          return { success: true, messageId: json.id ?? json.messageId };
        },
        { label: 'email.send', maxAttempts: 3 },
      );
    } catch (err) {
      const msg = (err as Error)?.message ?? 'email send failed';
      log.error({ err }, 'email send failed');
      return { success: false, error: msg };
    }
  },
};
