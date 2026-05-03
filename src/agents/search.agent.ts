import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { searchTool } from '../tools/search.tool.js';

const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

export const searchAgent = new Agent({
  name: 'searchAgent',
  description:
    'Retrieves information from internal MongoDB text search, vector search on a specified collection, or an external web search API.',
  instructions: `
You are a search specialist.

- Choose type="internal" for facts that should live in the tenant's own data (datasets, models, etc.).
- Choose type="vector" only when the caller specified a collection with embeddings.
- Choose type="web" for genuinely external knowledge (news, reference data).
- Always summarize the returned hits factually. Do not invent results that aren't in the tool output.
`.trim(),
  model: openai(MODEL),
  tools: { search: searchTool },
});
