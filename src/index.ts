/**
 * CLI: `tsx src/index.ts [example#] "your prompt"`
 *
 * Examples (mirroring the four scenarios in the design doc):
 *   1 — Create a model
 *   2 — Create a dataset and link it to a model
 *   3 — Define a one-to-many relationship between two models
 *   4 — Search + chart pipeline
 *
 *   tsx src/index.ts 1
 *   tsx src/index.ts custom "How many datasets exist for tenant acme?"
 */

import { randomUUID } from 'node:crypto';
import { runWithContext } from './middleware/tenant.js';
import { orchestrate } from './workflows/orchestrator.js';
import { closeMongo } from './config/database.js';
import { logger } from './utils/logger.js';
import './config/mastra.js';

const EXAMPLES: Record<string, string> = {
  '1': 'Create a new model called "SalesForecast" on dataset "sales_data" with inputs [year, revenue].',
  '2': 'Add a dataset called "sales_data" sourced from file.csv, then link it to the SalesForecast model.',
  '3': 'Establish a one-to-many relationship from the User model to the Order model.',
  '4':
    'Search internal collections for 2025 quarterly revenue and produce a bar chart titled "2025 Sales by Quarter".',
};

async function main() {
  const [arg1, ...rest] = process.argv.slice(2);
  const which = arg1 ?? '1';
  const prompt = which === 'custom' ? rest.join(' ') : EXAMPLES[which];
  if (!prompt) {
    console.error(
      'Usage: tsx src/index.ts <1|2|3|4|custom "your prompt">\n' +
        Object.entries(EXAMPLES)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n'),
    );
    process.exit(1);
  }

  const ctx = {
    tenantId: process.env.DEMO_TENANT_ID ?? 'demo-tenant',
    userId: process.env.DEMO_USER_ID ?? 'demo-user',
    roles: ['admin'],
    requestId: randomUUID(),
  };

  logger.info({ prompt, ctx }, 'running example');

  try {
    const out = await runWithContext(ctx, () => orchestrate({ prompt }));
    console.log('\n=== PLAN ===');
    console.log(JSON.stringify(out.plan, null, 2));
    console.log('\n=== RESULTS ===');
    for (const r of out.results) {
      const status = r.ok ? '✓' : '✗';
      console.log(
        `${status} step ${r.stepId} ${r.agent}.${r.action} (${r.durationMs}ms)` +
          (r.error ? `\n  error: ${r.error.message}` : ''),
      );
      if (r.ok && r.output) {
        const preview = JSON.stringify(r.output).slice(0, 200);
        console.log(`  output: ${preview}${preview.length >= 200 ? '…' : ''}`);
      }
    }
    console.log('\n=== ANSWER ===');
    console.log(out.answer);
    if (out.charts.length) {
      console.log('\n=== CHARTS ===');
      for (const c of out.charts) {
        console.log(`step ${c.stepId}: ${c.imageUrl ?? '(client-render)'}`);
      }
    }
  } catch (err) {
    logger.error({ err }, 'orchestration failed');
    process.exitCode = 1;
  } finally {
    await closeMongo();
  }
}

main();
