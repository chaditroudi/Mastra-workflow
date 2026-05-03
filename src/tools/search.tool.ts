import { createTool } from '@mastra/core/tools';
import { searchService } from '../services/search.service.js';
import { SearchToolInputSchema, SearchToolOutputSchema } from '../schemas/agents.js';

export const searchTool = createTool({
  id: 'search',
  description:
    'Search for information. type="internal" runs MongoDB text search across the tenant\'s collections; ' +
    'type="vector" runs $vectorSearch on a specified collection; type="web" hits the configured external search API.',
  inputSchema: SearchToolInputSchema,
  outputSchema: SearchToolOutputSchema,
  execute: async ({ context }) => searchService.execute(context),
});
