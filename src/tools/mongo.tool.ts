import { createTool } from '@mastra/core/tools';
import { mongoService } from '../services/mongo.service.js';
import { MongoToolInputSchema, MongoToolOutputSchema } from '../schemas/agents.js';

/**
 * MongoDB tool. The Mongo agent exposes this single tool — the LLM picks the
 * `action` field. Tenant scoping and transactions are handled inside the
 * service, not in the tool definition, so the LLM can never bypass them.
 */
export const mongoTool = createTool({
  id: 'mongo',
  description:
    'Execute a MongoDB operation: create, query, update, delete, link (transactional), or aggregate. ' +
    'All operations are automatically scoped to the current tenant. ' +
    'Use `link` to create a relationship between two documents — supply { from, to, fromId, toId, relation }.',
  inputSchema: MongoToolInputSchema,
  outputSchema: MongoToolOutputSchema,
  execute: async ({ context }) => mongoService.execute(context),
});
