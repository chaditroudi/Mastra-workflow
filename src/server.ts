/**
 * Production server entry. Boots the app from `createApp()` and wires up
 * graceful shutdown.
 */
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { closeMongo } from './config/database.js';

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => logger.info({ port }, 'http listening'));

async function shutdown(sig: string) {
  logger.info({ sig }, 'shutting down');
  server.close(() => {
    closeMongo()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  // Force exit after 10s if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
