import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { emailTool } from '../tools/email.tool.js';

const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

export const emailAgent = new Agent({
  name: 'emailAgent',
  description: 'Sends formatted emails with optional attachments. Requires admin or operator role.',
  instructions: `
You compose and send transactional / report emails.

- Always call the \`email\` tool — do not pretend to send.
- Keep subjects concise (under 80 chars) and informative.
- When the caller supplies a chart image URL from a previous step, include it as an attachment.
- If a send fails, return the provider's error verbatim — do not invent retry advice.
`.trim(),
  model: openai(MODEL),
  tools: { email: emailTool },
});
