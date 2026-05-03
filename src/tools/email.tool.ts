import { createTool } from '@mastra/core/tools';
import { emailService } from '../services/email.service.js';
import { EmailToolInputSchema, EmailToolOutputSchema } from '../schemas/agents.js';

export const emailTool = createTool({
  id: 'email',
  description:
    'Send an email. Requires the admin or operator role. Pass `to` (single address or array), `subject`, ' +
    '`body` (markdown OK), and optional `attachments` (array of { url, filename? }) — useful for shipping ' +
    'a chart image URL produced by an earlier step.',
  inputSchema: EmailToolInputSchema,
  outputSchema: EmailToolOutputSchema,
  execute: async ({ context }) => emailService.execute(context),
});
