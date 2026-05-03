import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { mongoService } from '../services/mongo.service.js';
import { searchService } from '../services/search.service.js';
import { chartService } from '../services/chart.service.js';
import { logger } from '../utils/logger.js';

/**
 * Mastra-native workflow demonstrating the graph-based pattern from the design
 * doc — `step.then()`, `step.parallel()` etc. — as an alternative to our
 * IR-driven orchestrator.
 *
 * When to use which:
 *
 *   - The IR orchestrator (workflows/orchestrator.ts) is best when the shape
 *     of the work is decided by the LLM at runtime — most user prompts.
 *
 *   - A Mastra workflow like this one is best when the graph is FIXED and you
 *     want explicit typed inputs/outputs between steps, retries declared
 *     per-step, and visibility in Mastra's playground / observability tools.
 *     Examples: scheduled report generation, onboarding flows, fixed ETL.
 *
 * This particular workflow implements example #2 from the design doc:
 *   "Add a dataset and link it to a model".
 *
 * Steps:
 *   1. createDatasetStep   — insert into Datasets, return its id
 *   2. lookupModelStep     — find the target model by name (parallel with #1)
 *   3. linkStep            — create the relationship doc transactionally
 *   4. previewStep         — generate a small sanity-check chart of related counts
 */

/* ------------------------------------------------------------------ */
/* Step 1: createDataset                                                */
/* ------------------------------------------------------------------ */

const createDatasetStep = createStep({
  id: 'create-dataset',
  description: 'Insert a new Datasets document.',
  inputSchema: z.object({
    datasetName: z.string(),
    source: z.string(),
    targetModelName: z.string(),
  }),
  outputSchema: z.object({
    datasetName: z.string(),
    targetModelName: z.string(),
    datasetId: z.string(),
  }),
  retries: 2,
  execute: async ({ inputData }) => {
    const out = await mongoService.execute({
      action: 'create',
      collection: 'Datasets',
      data: { name: inputData.datasetName, source: inputData.source },
    });
    if (!out.success || !out.insertedId) {
      throw new Error(out.error ?? 'Failed to insert dataset');
    }
    logger.info({ datasetId: out.insertedId }, 'workflow: dataset created');
    return {
      datasetName: inputData.datasetName,
      targetModelName: inputData.targetModelName,
      datasetId: out.insertedId,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Step 2: lookupModel                                                  */
/* ------------------------------------------------------------------ */

const lookupModelStep = createStep({
  id: 'lookup-model',
  description: 'Find the model document the dataset will be linked to.',
  inputSchema: z.object({
    datasetName: z.string(),
    targetModelName: z.string(),
    datasetId: z.string(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    modelId: z.string(),
    modelName: z.string(),
  }),
  retries: 2,
  execute: async ({ inputData }) => {
    const out = await mongoService.execute({
      action: 'query',
      collection: 'Models',
      query: { name: inputData.targetModelName },
      options: { limit: 1 },
    });
    const docs = out.result as { _id: { toString(): string }; name: string }[] | undefined;
    if (!docs?.[0]) throw new Error(`Model "${inputData.targetModelName}" not found`);
    return {
      datasetId: inputData.datasetId,
      modelId: docs[0]._id.toString(),
      modelName: docs[0].name,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Step 3: link                                                         */
/* ------------------------------------------------------------------ */

const linkStep = createStep({
  id: 'link',
  description: 'Transactionally create the Models<->Datasets relationship.',
  inputSchema: z.object({
    datasetId: z.string(),
    modelId: z.string(),
    modelName: z.string(),
  }),
  outputSchema: z.object({
    relationshipId: z.string(),
    modelId: z.string(),
    datasetId: z.string(),
  }),
  retries: 3, // The Mongo driver also retries TransientTransactionError internally;
              // this is a belt-and-braces extra layer at the workflow level.
  execute: async ({ inputData }) => {
    const out = await mongoService.execute({
      action: 'link',
      collection: 'Relationships',
      data: {
        from: 'Models',
        to: 'Datasets',
        fromId: inputData.modelId,
        toId: inputData.datasetId,
        relation: 'uses',
      },
    });
    if (!out.success || !out.insertedId) throw new Error(out.error ?? 'link failed');
    return {
      relationshipId: out.insertedId,
      modelId: inputData.modelId,
      datasetId: inputData.datasetId,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Step 4: previewChart                                                 */
/* ------------------------------------------------------------------ */

const previewChartStep = createStep({
  id: 'preview-chart',
  description: 'Render a small confirmation chart showing 1 model linked to 1 dataset.',
  inputSchema: z.object({
    relationshipId: z.string(),
    modelId: z.string(),
    datasetId: z.string(),
  }),
  outputSchema: z.object({
    relationshipId: z.string(),
    chartConfig: z.record(z.string(), z.unknown()),
    imageUrl: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const chart = chartService.execute({
      chartType: 'bar',
      title: 'Linked entities',
      data: {
        labels: ['Models', 'Datasets', 'Relationships'],
        datasets: [{ label: 'Touched by this run', data: [1, 1, 1] }],
      },
    });
    return {
      relationshipId: inputData.relationshipId,
      chartConfig: chart.chartConfig,
      imageUrl: chart.imageUrl,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Workflow definition                                                  */
/* ------------------------------------------------------------------ */

/**
 * Sequential composition: createDataset → lookupModel → link → previewChart.
 *
 * Note: the dataset insert and the model lookup *could* run in parallel since
 * they don't depend on each other. We're keeping them sequential here for the
 * sake of a clean, readable example. Parallel form below for reference:
 *
 *   workflow.parallel([createDatasetStep, lookupModelStep])
 *
 * The `.commit()` call freezes the graph and returns a runnable Workflow.
 */
export const createDatasetAndLinkWorkflow = createWorkflow({
  id: 'create-dataset-and-link',
  description: 'Create a Datasets row and link it to an existing Models row (transactional).',
  inputSchema: z.object({
    datasetName: z.string(),
    source: z.string(),
    targetModelName: z.string(),
  }),
  outputSchema: z.object({
    relationshipId: z.string(),
    chartConfig: z.record(z.string(), z.unknown()),
    imageUrl: z.string().optional(),
  }),
  steps: [createDatasetStep, lookupModelStep, linkStep, previewChartStep],
})
  .then(createDatasetStep)
  .then(lookupModelStep)
  .then(linkStep)
  .then(previewChartStep)
  .commit();

/* ------------------------------------------------------------------ */
/* Search-only example: parallel internal + web search                 */
/* ------------------------------------------------------------------ */

const internalSearchStep = createStep({
  id: 'internal-search',
  description: 'Run an internal Mongo text search.',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(z.unknown()) }),
  execute: async ({ inputData }) => {
    const r = await searchService.execute({ query: inputData.query, type: 'internal', limit: 5 });
    return { results: r.results };
  },
});

const webSearchStep = createStep({
  id: 'web-search',
  description: 'Run an external web search (no-op when SEARCH_API_URL is unset).',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(z.unknown()) }),
  execute: async ({ inputData }) => {
    const r = await searchService.execute({ query: inputData.query, type: 'web', limit: 5 });
    return { results: r.results };
  },
});

/**
 * Parallel-fanout example. Both searches run concurrently; the output schema
 * contains both step outputs keyed by step id.
 */
export const dualSearchWorkflow = createWorkflow({
  id: 'dual-search',
  description: 'Hit internal and web search in parallel and return both result sets.',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({
    'internal-search': z.object({ results: z.array(z.unknown()) }),
    'web-search': z.object({ results: z.array(z.unknown()) }),
  }),
  steps: [internalSearchStep, webSearchStep],
})
  .parallel([internalSearchStep, webSearchStep])
  .commit();
