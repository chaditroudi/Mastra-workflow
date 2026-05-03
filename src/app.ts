import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from './middleware/auth.js';
import { orchestrate } from './workflows/orchestrator.js';
import { PlanSchema } from './schemas/ir.js';
import { AppError } from './utils/errors.js';
import { logger } from './utils/logger.js';
// Import the Mastra instance for its side effect (registers agents).
import './config/mastra.js';

/**
 * Build the Express app. Factory style so tests can spin up an isolated app
 * without binding a port and without triggering the SIGINT/SIGTERM handlers
 * defined in src/server.ts.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Static demo client at /. Includes the HTML page that calls /api/orchestrate.
  app.use(express.static('public'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'mastra-workflow', uptime: process.uptime() });
  });

  // All real endpoints require tenant context.
  app.use('/api', authMiddleware);

  /**
   * POST /api/orchestrate
   *   { prompt: string, history?: [...], plan?: Plan }
   *
   * Returns { plan, results, answer, charts }.
   */
  app.post('/api/orchestrate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prompt, history, plan } = req.body ?? {};
      if (!plan && (typeof prompt !== 'string' || !prompt.trim())) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'prompt is required' } });
      }
      let parsedPlan;
      if (plan) {
        const parsed = PlanSchema.safeParse(plan);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: { code: 'VALIDATION_ERROR', message: 'invalid plan', details: parsed.error.flatten() } });
        }
        parsedPlan = parsed.data;
      }
      const out = await orchestrate({ prompt, history, plan: parsedPlan });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/plan — planning only (NL → IR), no execution. Useful for previews
   * and for letting a human approve the plan before running it.
   */
  app.post('/api/plan', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prompt, history } = req.body ?? {};
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'prompt is required' } });
      }
      const { planOnly } = await import('./workflows/orchestrator.helpers.js');
      const plan = await planOnly(prompt, history);
      res.json({ plan });
    } catch (err) {
      next(err);
    }
  });

  // Error mapper. AppError → its statusCode/JSON; everything else → 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      logger.warn({ err }, 'request failed');
      return res.status(err.statusCode).json(err.toJSON());
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: (err as Error)?.message ?? 'internal error' } });
  });

  return app;
}
