import { getDbForTenant, loadDbConfig } from '../config/database.js';
import { requireContext, scopeFilter } from '../middleware/tenant.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { AppError } from '../utils/errors.js';
import type { SearchToolInput, SearchToolOutput, SearchResult } from '../schemas/agents.js';

/**
 * Search service. Three back-ends:
 *   - "internal" → Mongo $text search across known collections.
 *   - "vector"   → Mongo Atlas $vectorSearch (requires embeddings to be set up).
 *   - "web"      → optional external HTTP API behind SEARCH_API_URL/SEARCH_API_KEY.
 *
 * For "web" with no API configured, returns an empty list rather than failing —
 * this keeps the demo runnable without external creds.
 */
export const searchService = {
  async execute(input: SearchToolInput): Promise<SearchToolOutput> {
    switch (input.type) {
      case 'web':
        return webSearch(input);
      case 'vector':
        return vectorSearch(input);
      case 'internal':
      default:
        return internalTextSearch(input);
    }
  },
};

async function internalTextSearch(input: SearchToolInput): Promise<SearchToolOutput> {
  const ctx = requireContext();
  const db = await getDbForTenant(ctx.tenantId);
  const collections = input.collection
    ? [input.collection]
    : ((await db.listCollections({}, { nameOnly: true }).toArray()) as { name: string }[]).map((c) => c.name);

  const cfg = loadDbConfig();
  const isolated = cfg.strategy === 'isolated';

  const all: SearchResult[] = [];
  for (const name of collections) {
    if (name.startsWith('system.') || name === 'Relationships') continue;
    try {
      const col = db.collection(name);
      const filter = isolated
        ? { $text: { $search: input.query } }
        : { ...scopeFilter(), $text: { $search: input.query } };
      const docs = await col
        .find(filter, { projection: { score: { $meta: 'textScore' } } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(input.limit)
        .toArray();
      for (const d of docs) {
        all.push({
          title: String(d.name ?? d.title ?? d._id),
          snippet: summarizeDoc(d),
          score: typeof d.score === 'number' ? d.score : undefined,
          source: name,
          data: d as Record<string, unknown>,
        });
      }
    } catch (err) {
      // Most likely cause: no text index on this collection. That's expected
      // for a fresh DB — log at debug and move on.
      logger.debug({ name, err: (err as Error).message }, 'text search skipped collection');
    }
  }

  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { results: all.slice(0, input.limit) };
}

async function vectorSearch(input: SearchToolInput): Promise<SearchToolOutput> {
  const ctx = requireContext();
  if (!input.collection) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: 'vector search requires `collection`',
      statusCode: 400,
    });
  }
  const db = await getDbForTenant(ctx.tenantId);
  const col = db.collection(input.collection);

  // Real embeddings would come from an embedding provider; we stub a hash-vector
  // here just so the pipeline runs end-to-end in the demo.
  const queryVector = pseudoEmbed(input.query);

  try {
    const docs = await col
      .aggregate([
        {
          $vectorSearch: {
            index: 'default',
            path: 'embedding',
            queryVector,
            numCandidates: input.limit * 10,
            limit: input.limit,
          },
        },
        { $match: scopeFilter() },
        { $project: { embedding: 0 } },
      ])
      .toArray();
    return {
      results: docs.map((d) => ({
        title: String(d.name ?? d.title ?? d._id),
        snippet: summarizeDoc(d),
        source: input.collection!,
        data: d as Record<string, unknown>,
      })),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'vector search not available; falling back to text');
    return internalTextSearch(input);
  }
}

async function webSearch(input: SearchToolInput): Promise<SearchToolOutput> {
  const url = process.env.SEARCH_API_URL;
  const key = process.env.SEARCH_API_KEY;
  if (!url) {
    logger.info('web search not configured; returning empty');
    return { results: [] };
  }
  return withRetry(
    async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ q: input.query, limit: input.limit }),
      });
      if (!r.ok) {
        throw new AppError({
          code: 'UPSTREAM_FAILURE',
          message: `Search API ${r.status}`,
          retriable: r.status >= 500,
        });
      }
      const json = (await r.json()) as { results?: SearchResult[] };
      return { results: (json.results ?? []).slice(0, input.limit) };
    },
    { label: 'search.web', maxAttempts: 3 },
  );
}

function summarizeDoc(d: Record<string, unknown>): string {
  const fields = ['description', 'summary', 'snippet', 'name', 'title'];
  for (const f of fields) {
    const v = d[f];
    if (typeof v === 'string' && v.length) return v.length > 200 ? v.slice(0, 197) + '…' : v;
  }
  return JSON.stringify(d).slice(0, 200);
}

function pseudoEmbed(s: string): number[] {
  const v = new Array<number>(384).fill(0);
  for (let i = 0; i < s.length; i++) v[i % v.length] += s.charCodeAt(i) / 1000;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}
