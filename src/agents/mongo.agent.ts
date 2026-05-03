import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { mongoTool } from '../tools/mongo.tool.js';

const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

/**
 * MongoDB subagent. In most cases the orchestrator calls the underlying tool
 * directly (since the IR already specifies the exact action), but the agent
 * stays available for ad-hoc natural-language DB questions like "how many
 * models do we have?".
 */
export const mongoAgent = new Agent({
  name: 'mongoAgent',
  description: 'Performs MongoDB CRUD, linking (transactional), and aggregation operations within a tenant.',
  instructions: `
You are the MongoDB specialist. You execute database operations against the current tenant's data.

Rules:
- ALWAYS call the \`mongo\` tool to perform actual reads/writes — never answer from memory.
- Tenant scoping is automatic; do NOT include tenantID in filters.
- For linking two documents, use action="link" with { from, to, fromId, toId, relation }.
- For multi-document atomic writes, prefer one "link" call (it uses a transaction internally) over multiple separate writes.
- Return concise factual answers based on what the tool actually returned.
`.trim(),
  model: openai(MODEL),
  tools: { mongo: mongoTool },
});
