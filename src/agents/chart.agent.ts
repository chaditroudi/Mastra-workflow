import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { chartTool } from '../tools/chart.tool.js';

const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

export const chartAgent = new Agent({
  name: 'chartAgent',
  description: 'Builds Chart.js chart configurations from labels + datasets.',
  instructions: `
You generate chart configurations.

- Pick the chart type that best fits the data shape: bar/line for time series, pie/doughnut for parts of a whole,
  scatter for paired numeric data, radar for multi-dimensional comparisons.
- Always call the \`chart\` tool — never make up an imageUrl or chartConfig.
- Echo back the title and the chartConfig.type in your text answer so the caller can confirm.
`.trim(),
  model: openai(MODEL),
  tools: { chart: chartTool },
});
