import { describe, it, expect } from 'vitest';
import { executePlan, renderFinal } from '../src/workflows/executor.js';
import type { Plan, AgentName } from '../src/schemas/ir.js';

/**
 * End-to-end tests for the four example workflows from the design doc, run
 * with a stubbed agent runner. This validates that the IR plan shape we
 * recommend in the supervisor's instructions actually executes correctly.
 */

const EXAMPLE_PLANS: Record<string, Plan> = {
  // 1: Create a model.
  createModel: {
    summary: 'Create the SalesForecast model',
    steps: [
      {
        id: 1,
        agent: 'mongodb',
        action: 'create',
        args: {
          collection: 'Models',
          data: { name: 'SalesForecast', inputs: ['year', 'revenue'], dataset: 'sales_data' },
        },
        rationale: 'Insert the new model document.',
        parallelizable: false,
        dependsOn: [],
      },
    ],
    finalTemplate: 'Created model with id $step:1.insertedId',
  },

  // 2: Create a dataset and link it to a model — multi-step with placeholders.
  createDatasetAndLink: {
    summary: 'Create dataset and link it to SalesForecast',
    steps: [
      {
        id: 1,
        agent: 'mongodb',
        action: 'create',
        args: { collection: 'Datasets', data: { name: 'sales_data', source: 'file.csv' } },
        rationale: 'Insert the new dataset.',
        parallelizable: false,
        dependsOn: [],
      },
      {
        id: 2,
        agent: 'mongodb',
        action: 'query',
        args: { collection: 'Models', query: { name: 'SalesForecast' }, options: { limit: 1 } },
        rationale: 'Look up the existing model.',
        parallelizable: false,
        dependsOn: [],
      },
      {
        id: 3,
        agent: 'mongodb',
        action: 'link',
        args: {
          collection: 'Relationships',
          data: {
            from: 'Models',
            to: 'Datasets',
            fromId: '$step:2.result[0]._id',
            toId: '$step:1.insertedId',
            relation: 'uses',
          },
        },
        rationale: 'Link the model to the dataset (transactional).',
        parallelizable: false,
        dependsOn: [1, 2],
      },
    ],
    finalTemplate: 'Linked dataset $step:1.insertedId to model $step:2.result[0]._id (rel $step:3.insertedId).',
  },

  // 4: Search + chart pipeline.
  searchAndChart: {
    summary: 'Find revenue and draw a bar chart',
    steps: [
      {
        id: 1,
        agent: 'search',
        action: 'find',
        args: { query: '2025 quarterly revenue', type: 'internal', limit: 4 },
        rationale: 'Pull quarterly revenue data points.',
        parallelizable: false,
        dependsOn: [],
      },
      {
        id: 2,
        agent: 'chart',
        action: 'render',
        args: {
          chartType: 'bar',
          title: '2025 Sales by Quarter',
          data: {
            labels: ['Q1', 'Q2', 'Q3', 'Q4'],
            datasets: [{ label: 'Revenue', data: [120, 140, 160, 200] }],
          },
        },
        rationale: 'Render the bar chart.',
        parallelizable: false,
        dependsOn: [1],
      },
    ],
    finalTemplate: 'Chart ready at $step:2.imageUrl',
  },
};

describe('canonical example plans', () => {
  it('executes a single create-model step', async () => {
    const runner = async (_a: AgentName, _b: string, _c: Record<string, unknown>) => ({
      success: true,
      insertedId: 'model_42',
    });
    const results = await executePlan(EXAMPLE_PLANS.createModel, runner);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(renderFinal(EXAMPLE_PLANS.createModel, results)).toBe('Created model with id model_42');
  });

  it('executes a 3-step plan with placeholder substitution', async () => {
    let call = 0;
    const runner = async (agent: AgentName, action: string, args: Record<string, unknown>) => {
      call++;
      if (call === 1) return { success: true, insertedId: 'ds_1' };
      if (call === 2) return { success: true, result: [{ _id: 'm_1', name: 'SalesForecast' }] };
      // Step 3: link — the placeholders should be resolved by now.
      expect((args as { data: { fromId: string; toId: string } }).data.fromId).toBe('m_1');
      expect((args as { data: { fromId: string; toId: string } }).data.toId).toBe('ds_1');
      expect(agent).toBe('mongodb');
      expect(action).toBe('link');
      return { success: true, insertedId: 'rel_1' };
    };
    const results = await executePlan(EXAMPLE_PLANS.createDatasetAndLink, runner);
    expect(results.every((r) => r.ok)).toBe(true);
    const answer = renderFinal(EXAMPLE_PLANS.createDatasetAndLink, results);
    expect(answer).toContain('rel_1');
    expect(answer).toContain('ds_1');
    expect(answer).toContain('m_1');
  });

  it('executes search-then-chart and returns a chart in the result set', async () => {
    const runner = async (agent: AgentName) => {
      if (agent === 'search') {
        return { results: [{ title: 'Q1', snippet: '120', source: 'Sales' }] };
      }
      // chart
      return {
        chartConfig: { type: 'bar', data: { labels: ['Q1'], datasets: [{ data: [120] }] } },
        imageUrl: 'https://quickchart.io/chart?c=...',
      };
    };
    const results = await executePlan(EXAMPLE_PLANS.searchAndChart, runner);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(renderFinal(EXAMPLE_PLANS.searchAndChart, results)).toContain('quickchart.io');
  });
});
