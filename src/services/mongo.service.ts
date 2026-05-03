import type { Document, Filter } from 'mongodb';
import { ObjectId } from 'mongodb';
import { getDbForTenant, runTransaction, loadDbConfig } from '../config/database.js';
import { requireContext, scopeFilter, stampTenant } from '../middleware/tenant.js';
import { withRetry } from '../utils/retry.js';
import { classifyMongoError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { MongoToolInput, MongoToolOutput } from '../schemas/agents.js';

const cfg = (() => {
  try {
    return loadDbConfig();
  } catch {
    return null;
  }
})();

/**
 * Apply tenant scoping to a filter only if we're in shared-DB mode. In
 * isolated mode, the database itself is per-tenant so we don't need it.
 */
function tenantFilter(filter: Record<string, unknown> = {}): Record<string, unknown> {
  if ((cfg ?? loadDbConfig()).strategy === 'isolated') return filter;
  return scopeFilter(filter);
}

function tenantStamp<T extends Record<string, unknown>>(doc: T): T {
  if ((cfg ?? loadDbConfig()).strategy === 'isolated') return doc;
  return stampTenant(doc) as T;
}

export const mongoService = {
  async execute(input: MongoToolInput): Promise<MongoToolOutput> {
    const ctx = requireContext();
    const log = logger.child({ tenantId: ctx.tenantId, action: input.action, collection: input.collection });

    try {
      return await withRetry(() => dispatch(input), {
        label: `mongo.${input.action}`,
        maxAttempts: 3,
        baseDelayMs: 150,
      });
    } catch (err) {
      const e = err instanceof Error ? classifyMongoError(err) : classifyMongoError(new Error(String(err)));
      log.error({ err: e }, 'mongo operation failed');
      return { success: false, error: e.message };
    }
  },
};

async function dispatch(input: MongoToolInput): Promise<MongoToolOutput> {
  const ctx = requireContext();
  const log = logger.child({ tenantId: ctx.tenantId, action: input.action, collection: input.collection });
  const db = await getDbForTenant(ctx.tenantId);
  const col = db.collection(input.collection);

  switch (input.action) {
    /* ----------------------------- create ----------------------------- */
    case 'create': {
      if (!input.data) throw new ValidationError('`data` is required for create');
      if (Array.isArray(input.data)) {
        const stamped = input.data.map((d) => tenantStamp(d));
        const res = await col.insertMany(stamped);
        log.info({ count: res.insertedCount }, 'inserted many');
        return {
          success: true,
          result: Object.values(res.insertedIds).map((id) => id.toString()),
        };
      } else {
        const res = await col.insertOne(tenantStamp(input.data));
        log.info({ id: res.insertedId.toString() }, 'inserted one');
        return { success: true, insertedId: res.insertedId.toString() };
      }
    }

    /* ----------------------------- query ------------------------------ */
    case 'query': {
      const filter = tenantFilter(coerceIds(input.query)) as Filter<Document>;
      const cursor = col.find(filter, {
        projection: input.options?.projection,
        sort: input.options?.sort as Record<string, 1 | -1> | undefined,
        limit: input.options?.limit ?? 100,
        skip: input.options?.skip,
      });
      const docs = await cursor.toArray();
      log.debug({ count: docs.length }, 'query complete');
      return { success: true, result: docs };
    }

    /* ----------------------------- update ----------------------------- */
    case 'update': {
      if (!input.query) throw new ValidationError('`query` (filter) is required for update');
      if (!input.data) throw new ValidationError('`data` (update spec) is required for update');
      const filter = tenantFilter(coerceIds(input.query)) as Filter<Document>;
      const update = wrapUpdate(input.data as Record<string, unknown>);
      const opts = { upsert: input.options?.upsert ?? false };
      const res = input.options?.many
        ? await col.updateMany(filter, update, opts)
        : await col.updateOne(filter, update, opts);
      log.info({ matched: res.matchedCount, modified: res.modifiedCount }, 'update complete');
      return {
        success: true,
        matchedCount: res.matchedCount,
        modifiedCount: res.modifiedCount,
      };
    }

    /* ----------------------------- delete ----------------------------- */
    case 'delete': {
      if (!input.query) throw new ValidationError('`query` (filter) is required for delete');
      const filter = tenantFilter(coerceIds(input.query)) as Filter<Document>;
      const res = input.options?.many ? await col.deleteMany(filter) : await col.deleteOne(filter);
      log.info({ deleted: res.deletedCount }, 'delete complete');
      return { success: true, deletedCount: res.deletedCount };
    }

    /* ------------------------------ link ------------------------------ */
    // `link` creates a relationship document atomically and bumps a counter on
    // both sides — wrapped in a transaction so partial state is impossible.
    case 'link': {
      const d = (input.data ?? {}) as {
        from?: string;
        to?: string;
        fromId?: string;
        toId?: string;
        relation?: string;
        meta?: Record<string, unknown>;
      };
      if (!d.from || !d.to || !d.fromId || !d.toId) {
        throw new ValidationError('link requires { from, to, fromId, toId }');
      }
      const result = await runTransaction(async (session) => {
        const relCol = db.collection('Relationships');
        const fromCol = db.collection(d.from!);
        const toCol = db.collection(d.to!);

        const relDoc = tenantStamp({
          from: d.from,
          to: d.to,
          fromId: new ObjectId(d.fromId),
          toId: new ObjectId(d.toId),
          relation: d.relation ?? 'related',
          meta: d.meta ?? {},
          createdAt: new Date(),
        });

        const inserted = await relCol.insertOne(relDoc, { session });

        // Bump a denormalized link count on both endpoints — purely so reads
        // don't need an aggregation. Optional, kept inside the transaction.
        await fromCol.updateOne(
          tenantFilter({ _id: new ObjectId(d.fromId) }) as Filter<Document>,
          { $inc: { [`links.${d.to}`]: 1 } },
          { session },
        );
        await toCol.updateOne(
          tenantFilter({ _id: new ObjectId(d.toId) }) as Filter<Document>,
          { $inc: { [`links.${d.from}`]: 1 } },
          { session },
        );
        return inserted.insertedId.toString();
      });
      log.info({ relId: result }, 'link complete');
      return { success: true, insertedId: result };
    }

    /* ---------------------------- aggregate --------------------------- */
    case 'aggregate': {
      const userPipeline = input.pipeline ?? [];
      // Prepend a $match for tenant scoping (shared mode only) — this is
      // critical: never trust the LLM to put the filter in itself.
      const pipeline =
        (cfg ?? loadDbConfig()).strategy === 'shared'
          ? [{ $match: { tenantID: requireContext().tenantId } }, ...userPipeline]
          : userPipeline;
      const docs = await col.aggregate(pipeline, { allowDiskUse: true }).toArray();
      log.debug({ count: docs.length }, 'aggregate complete');
      return { success: true, result: docs };
    }

    default: {
      const _exhaustive: never = input.action;
      throw new ValidationError(`Unknown action: ${String(_exhaustive)}`);
    }
  }
}

/** Convert string `_id` values into ObjectId for query filters. */
function coerceIds(filter: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!filter) return {};
  const out: Record<string, unknown> = { ...filter };
  if (typeof out._id === 'string' && /^[a-f\d]{24}$/i.test(out._id)) {
    out._id = new ObjectId(out._id);
  }
  return out;
}

/**
 * If the caller passed a plain object (no operators), wrap it in `$set`. This
 * lets the LLM say `data: { status: "active" }` instead of needing to know the
 * Mongo update syntax.
 */
function wrapUpdate(data: Record<string, unknown>): Record<string, unknown> {
  const hasOperator = Object.keys(data).some((k) => k.startsWith('$'));
  return hasOperator ? data : { $set: data };
}
