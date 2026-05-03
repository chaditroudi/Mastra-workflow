import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    },
  }),
  base: { service: 'mastra-workflow' },
  redact: ['*.password', '*.apiKey', 'req.headers.authorization'],
});

/** Build a child logger with tenant + request context. */
export function withContext(ctx: {
  tenantId?: string;
  userId?: string;
  requestId?: string;
  agent?: string;
}) {
  return logger.child(ctx);
}

export type Logger = typeof logger;
