import { createTool } from '@mastra/core/tools';
import { chartService } from '../services/chart.service.js';
import { ChartToolInputSchema, ChartToolOutputSchema } from '../schemas/agents.js';

export const chartTool = createTool({
  id: 'chart',
  description:
    'Generate a Chart.js-compatible chart configuration. Returns both the JSON config and (when small enough) ' +
    'a QuickChart.io image URL. Supported chartTypes: bar, line, pie, doughnut, scatter, radar.',
  inputSchema: ChartToolInputSchema,
  outputSchema: ChartToolOutputSchema,
  execute: async ({ context }) => chartService.execute(context),
});
