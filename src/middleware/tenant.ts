import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantForbiddenError } from '../utils/errors.js';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  /** Roles for this user within the tenant (e.g. "admin", "analyst", "viewer"). */
  roles: string[];
  requestId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` with the supplied context bound to AsyncLocalStorage. */
export function runWithContext<T>(ctx: TenantContext, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(ctx, fn);
}

/** Throws if no context — the system requires every agent call to be tenant-scoped. */
export function requireContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantForbiddenError('No tenant context bound — refusing to run agent action');
  }
  return ctx;
}

export function tryGetContext(): TenantContext | undefined {
  return storage.getStore();
}

/** Stamp a document with tenantID before insert. Used by the Mongo tool. */
export function stampTenant<T extends Record<string, unknown>>(doc: T): T & { tenantID: string } {
  const ctx = requireContext();
  // Strip any caller-supplied tenantID/tenantId before stamping. An LLM (or
  // a malicious caller) could otherwise embed a different tenant's ID in
  // create payloads.
  const { tenantID: _a, tenantId: _b, ...rest } = doc as Record<string, unknown>;
  void _a;
  void _b;
  return { ...(rest as T), tenantID: ctx.tenantId };
}

/** Inject tenantID into every query for the "shared" strategy. */
export function scopeFilter(filter: Record<string, unknown> = {}): Record<string, unknown> {
  const ctx = requireContext();
  // Strip BOTH casings — `tenantID` is the canonical field name but a caller
  // (or an LLM-generated filter) might try `tenantId` to bypass the scope.
  const { tenantID: _a, tenantId: _b, ...rest } = filter;
  void _a;
  void _b;
  return { ...rest, tenantID: ctx.tenantId };
}

/** Throws TenantForbiddenError if the current context lacks any of the required roles. */
export function requireRole(...required: string[]): void {
  const ctx = requireContext();
  if (!required.some((r) => ctx.roles.includes(r))) {
    throw new TenantForbiddenError(`Requires one of roles: ${required.join(', ')}`);
  }
}
