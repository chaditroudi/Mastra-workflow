/**
 * Domain error hierarchy. The Supervisor and workflow steps inspect `retriable`
 * and `code` to decide whether to retry, abort, or surface a user-friendly message.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'TENANT_FORBIDDEN'
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'TRANSIENT_DB'
  | 'WRITE_CONCERN_TIMEOUT'
  | 'TRANSACTION_ABORTED'
  | 'PLAN_PARSE_ERROR'
  | 'AGENT_FAILURE'
  | 'UPSTREAM_FAILURE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retriable: boolean;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    retriable?: boolean;
    statusCode?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = opts.code;
    this.retriable = opts.retriable ?? false;
    this.statusCode = opts.statusCode ?? 500;
    this.details = opts.details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retriable: this.retriable,
        details: this.details,
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'VALIDATION_ERROR', message, statusCode: 400, details });
  }
}

export class TenantForbiddenError extends AppError {
  constructor(message = 'Tenant access denied') {
    super({ code: 'TENANT_FORBIDDEN', message, statusCode: 403 });
  }
}

export class AuthRequiredError extends AppError {
  constructor(message = 'Authentication required') {
    super({ code: 'AUTH_REQUIRED', message, statusCode: 401 });
  }
}

export class TransientDbError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ code: 'TRANSIENT_DB', message, retriable: true, statusCode: 503, cause });
  }
}

export class PlanParseError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'PLAN_PARSE_ERROR', message, statusCode: 422, details });
  }
}

/** Map a low-level MongoDB error into our hierarchy. */
export function classifyMongoError(err: unknown): AppError {
  const e = err as { code?: number; codeName?: string; message?: string; hasErrorLabel?: (l: string) => boolean };
  const msg = e?.message ?? 'Unknown MongoDB error';

  // Mongo driver attaches error labels for retriable/transient cases.
  if (typeof e?.hasErrorLabel === 'function') {
    if (e.hasErrorLabel('TransientTransactionError')) {
      return new AppError({
        code: 'TRANSACTION_ABORTED',
        message: `Transient transaction error: ${msg}`,
        retriable: true,
        statusCode: 503,
        cause: err,
      });
    }
    if (e.hasErrorLabel('UnknownTransactionCommitResult')) {
      return new AppError({
        code: 'WRITE_CONCERN_TIMEOUT',
        message: `Unknown commit result: ${msg}`,
        retriable: true,
        statusCode: 503,
        cause: err,
      });
    }
  }

  // 11000 = duplicate key
  if (e?.code === 11000) {
    return new AppError({ code: 'CONFLICT', message: `Duplicate key: ${msg}`, statusCode: 409, cause: err });
  }

  return new TransientDbError(msg, err);
}
