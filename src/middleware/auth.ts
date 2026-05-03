import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext, type TenantContext } from './tenant.js';
import { AuthRequiredError } from '../utils/errors.js';

/**
 * Authentication middleware. In production this would verify a JWT (Auth0,
 * Clerk, Cognito, etc.) and extract claims. Here we accept three trusted
 * headers — replace with real verification before deploying.
 *
 *   X-Tenant-Id: required
 *   X-User-Id:   optional
 *   X-Roles:     comma-separated, defaults to "viewer"
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenantId = headerOf(req, 'x-tenant-id');
  if (!tenantId) {
    return next(new AuthRequiredError('X-Tenant-Id header missing'));
  }
  const ctx: TenantContext = {
    tenantId,
    userId: headerOf(req, 'x-user-id'),
    roles: (headerOf(req, 'x-roles') ?? 'viewer').split(',').map((r) => r.trim()).filter(Boolean),
    requestId: headerOf(req, 'x-request-id') ?? randomUUID(),
  };
  res.setHeader('x-request-id', ctx.requestId);
  // Bind context for the entire downstream chain — services can call requireContext().
  runWithContext(ctx, () => {
    next();
  });
}

function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
