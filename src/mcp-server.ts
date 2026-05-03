/**
 * MCP server entry point.
 *
 * Packages the four service-backed tools (mongo, search, chart, email) as a
 * Model Context Protocol server, so any MCP-compatible client — Claude Desktop,
 * another Mastra agent, an external orchestrator — can call them as a
 * microservice. This is the "MCP servers" extensibility hook called out in the
 * design doc.
 *
 * Two transports are exposed:
 *   - stdio   (default; for Claude Desktop / direct subprocess clients)
 *   - http    (Streamable HTTP at /mcp; for browser / remote clients)
 *
 * Run:
 *   npm run mcp                # stdio
 *   MCP_TRANSPORT=http npm run mcp
 *
 * Multi-tenancy: every MCP request must carry tenant context. For stdio we
 * pull it from MCP_TENANT_ID / MCP_USER_ID / MCP_ROLES env vars (single-tenant
 * deployment). For HTTP we read X-Tenant-Id etc. from the per-request headers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { runWithContext, type TenantContext } from './middleware/tenant.js';
import { mongoService } from './services/mongo.service.js';
import { searchService } from './services/search.service.js';
import { chartService } from './services/chart.service.js';
import { emailService } from './services/email.service.js';
import {
  MongoToolInputSchema,
  SearchToolInputSchema,
  ChartToolInputSchema,
  EmailToolInputSchema,
} from './schemas/agents.js';
import { logger } from './utils/logger.js';
import { closeMongo } from './config/database.js';

/* ------------------------------------------------------------------ */
/* Build the server                                                    */
/* ------------------------------------------------------------------ */

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'mastra-workflow-system',
    version: '0.1.0',
  });

  // mongo tool — wrapped so the MCP layer never sees raw Mongo errors
  server.registerTool(
    'mongo',
    {
      description:
        'Execute a MongoDB operation against the current tenant: create, query, update, delete, link (transactional), or aggregate.',
      inputSchema: MongoToolInputSchema.shape,
    },
    async (args) => {
      const result = await mongoService.execute(MongoToolInputSchema.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'search',
    {
      description: 'Search internal Mongo collections, vector index, or external web.',
      inputSchema: SearchToolInputSchema.shape,
    },
    async (args) => {
      const result = await searchService.execute(SearchToolInputSchema.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'chart',
    {
      description: 'Generate a Chart.js-compatible chart configuration from labels + datasets.',
      inputSchema: ChartToolInputSchema.shape,
    },
    async (args) => {
      const result = chartService.execute(ChartToolInputSchema.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'email',
    {
      description: 'Send a transactional email. Requires admin or operator role on the calling tenant.',
      inputSchema: EmailToolInputSchema.shape,
    },
    async (args) => {
      const result = await emailService.execute(EmailToolInputSchema.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

/* ------------------------------------------------------------------ */
/* Stdio transport                                                     */
/* ------------------------------------------------------------------ */

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();

  // Stdio is single-process: bind tenant context for the lifetime of the connection.
  const ctx: TenantContext = {
    tenantId: process.env.MCP_TENANT_ID ?? 'default',
    userId: process.env.MCP_USER_ID,
    roles: (process.env.MCP_ROLES ?? 'admin').split(',').map((r) => r.trim()).filter(Boolean),
    requestId: randomUUID(),
  };

  // Wrap the connect call inside the AsyncLocalStorage scope so every inbound
  // tool call sees the same context.
  await runWithContext(ctx, async () => {
    await server.connect(transport);
    logger.info({ tenantId: ctx.tenantId }, 'MCP stdio server connected');
  });
}

/* ------------------------------------------------------------------ */
/* HTTP (Streamable HTTP) transport                                    */
/* ------------------------------------------------------------------ */

async function runHttp() {
  const port = Number(process.env.MCP_PORT ?? 3333);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Lazy-loaded so the stdio entry point doesn't pull in HTTP code at all.
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  app.post('/mcp', async (req: Request, res: Response) => {
    const tenantId = (req.header('x-tenant-id') ?? '').trim();
    if (!tenantId) {
      res.status(401).json({ error: 'X-Tenant-Id header required' });
      return;
    }
    const ctx: TenantContext = {
      tenantId,
      userId: req.header('x-user-id'),
      roles: (req.header('x-roles') ?? 'viewer').split(',').map((r) => r.trim()).filter(Boolean),
      requestId: req.header('x-request-id') ?? randomUUID(),
    };

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    await runWithContext(ctx, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  });

  app.listen(port, () => logger.info({ port }, 'MCP HTTP server listening on /mcp'));
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const transport = process.env.MCP_TRANSPORT ?? 'stdio';
  if (transport === 'http') {
    await runHttp();
  } else {
    await runStdio();
  }
}

process.on('SIGINT', async () => {
  await closeMongo();
  process.exit(0);
});

main().catch((err) => {
  logger.error({ err }, 'MCP server failed');
  process.exit(1);
});

// Re-export buildServer for tests / programmatic embedding.
export { buildServer };

// Type schema (used by zod for inputSchema.shape) — narrow re-exports for the
// MCP shape requirement (raw shape, not a full ZodObject).
export const _shapes = {
  mongo: MongoToolInputSchema.shape,
  search: SearchToolInputSchema.shape,
  chart: ChartToolInputSchema.shape,
  email: EmailToolInputSchema.shape,
};
void z; // suppress unused-import lint when zod isn't directly referenced
