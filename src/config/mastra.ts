import { Mastra } from '@mastra/core';
import { supervisorAgent } from '../agents/supervisor.agent.js';
import { mongoAgent } from '../agents/mongo.agent.js';
import { searchAgent } from '../agents/search.agent.js';
import { chartAgent } from '../agents/chart.agent.js';
import { emailAgent } from '../agents/email.agent.js';
import { createDatasetAndLinkWorkflow, dualSearchWorkflow } from '../workflows/mastra-workflows.js';

/**
 * Single Mastra instance. All five agents are registered so they can be
 * exercised individually through Mastra's HTTP server / playground; the
 * IR orchestrator (workflows/orchestrator.ts) is the canonical entry point
 * for LLM-driven dynamic plans.
 *
 * Mastra-native workflows (`workflows/mastra-workflows.ts`) are registered for
 * the case where the graph is fixed and you want explicit typed I/O between
 * steps and per-step retries.
 *
 * Mastra's internal logger is disabled because we already log everything we
 * need through pino in src/utils/logger.ts.
 */
export const mastra: Mastra = new Mastra({
  agents: {
    supervisor: supervisorAgent,
    mongoAgent,
    searchAgent,
    chartAgent,
    emailAgent,
  },
  workflows: {
    createDatasetAndLink: createDatasetAndLinkWorkflow,
    dualSearch: dualSearchWorkflow,
  },
  logger: false,
});
