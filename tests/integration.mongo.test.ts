import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { runWithContext } from '../src/middleware/tenant.js';
import { closeMongo, getDbForTenant } from '../src/config/database.js';
import { mongoService } from '../src/services/mongo.service.js';

/**
 * Integration tests against a real MongoDB replica set. Two ways to run:
 *
 *   1. Set TEST_MONGODB_URI to an existing replica-set URI (e.g. the one from
 *      `docker compose up`). Fastest, most reproducible — recommended for CI.
 *
 *   2. Leave TEST_MONGODB_URI unset and let mongodb-memory-server download a
 *      Mongo binary on first run. Requires network access to fastdl.mongodb.org.
 *
 * If neither works (e.g. an offline / sandboxed environment), the suite skips
 * itself cleanly rather than hanging or failing the whole `npm test` run.
 */

let repl: MongoMemoryReplSet | undefined;
let bootError: Error | undefined;

beforeAll(async () => {
  if (process.env.TEST_MONGODB_URI) {
    process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
  } else {
    try {
      repl = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
        binary: { version: '7.0.14' },
      });
      process.env.MONGODB_URI = repl.getUri();
    } catch (err) {
      bootError = err as Error;
      return;
    }
  }
  process.env.MONGODB_DB_PREFIX = 'test';
  process.env.TENANCY_STRATEGY = 'shared';
}, 180_000);

afterAll(async () => {
  await closeMongo();
  await repl?.stop();
});

beforeEach(async () => {
  if (bootError) return;
  await runWithContext(
    { tenantId: 'cleanup', roles: ['admin'], requestId: 'cleanup' },
    async () => {
      const db = await getDbForTenant('cleanup');
      const cols = await db.listCollections({}, { nameOnly: true }).toArray();
      await Promise.all(cols.map((c) => db.collection(c.name).drop().catch(() => undefined)));
    },
  );
});

/** Skip a test when boot failed (no Mongo reachable). Returns true when skipped. */
function skipIfBootFailed(t: { skip: () => void }): boolean {
  if (bootError) {
    console.warn(`[skip] integration: ${bootError.message.split('\n')[0]}`);
    t.skip();
    return true;
  }
  return false;
}

const ctx = (tenantId: string, roles: string[] = ['admin']) => ({
  tenantId,
  roles,
  requestId: `req-${tenantId}`,
});

describe('mongoService against a real replica set', () => {
  it('inserts and reads back a document with tenantID stamped', async (t) => {
    if (skipIfBootFailed(t)) return;
    await runWithContext(ctx('acme'), async () => {
      const insert = await mongoService.execute({
        action: 'create',
        collection: 'Models',
        data: { name: 'M1', inputs: ['a', 'b'] },
      });
      expect(insert.success).toBe(true);
      expect(insert.insertedId).toBeTruthy();

      const read = await mongoService.execute({
        action: 'query',
        collection: 'Models',
        query: { name: 'M1' },
      });
      expect(read.success).toBe(true);
      const docs = read.result as Array<{ name: string; tenantID: string }>;
      expect(docs).toHaveLength(1);
      expect(docs[0].tenantID).toBe('acme');
    });
  });

  it("isolates tenants — one tenant cannot see another's data", async (t) => {
    if (skipIfBootFailed(t)) return;
    await runWithContext(ctx('acme'), async () => {
      await mongoService.execute({ action: 'create', collection: 'Models', data: { name: 'AcmeModel' } });
    });
    await runWithContext(ctx('contoso'), async () => {
      await mongoService.execute({ action: 'create', collection: 'Models', data: { name: 'ContosoModel' } });
    });
    await runWithContext(ctx('acme'), async () => {
      const r = await mongoService.execute({ action: 'query', collection: 'Models', query: {} });
      const docs = r.result as Array<{ name: string }>;
      expect(docs.map((d) => d.name)).toEqual(['AcmeModel']);
    });
  });

  it('strips a malicious tenantID override from query filters', async (t) => {
    if (skipIfBootFailed(t)) return;
    await runWithContext(ctx('acme'), async () => {
      await mongoService.execute({ action: 'create', collection: 'Models', data: { name: 'AcmeOnly' } });
    });
    await runWithContext(ctx('attacker'), async () => {
      // Even though we *try* to set tenantID=acme, scopeFilter strips it and
      // re-injects the real tenant ('attacker') — so we should see nothing.
      const r = await mongoService.execute({
        action: 'query',
        collection: 'Models',
        query: { tenantID: 'acme' },
      });
      expect((r.result as unknown[]).length).toBe(0);
    });
  });

  it('link creates a relationship document atomically and bumps both counters', async (t) => {
    if (skipIfBootFailed(t)) return;
    await runWithContext(ctx('acme'), async () => {
      const m = await mongoService.execute({ action: 'create', collection: 'Models', data: { name: 'M' } });
      const d = await mongoService.execute({ action: 'create', collection: 'Datasets', data: { name: 'D' } });
      const link = await mongoService.execute({
        action: 'link',
        collection: 'Relationships',
        data: { from: 'Models', to: 'Datasets', fromId: m.insertedId!, toId: d.insertedId!, relation: 'uses' },
      });
      expect(link.success).toBe(true);

      const rel = (
        await mongoService.execute({ action: 'query', collection: 'Relationships', query: {} })
      ).result as Array<{ relation: string; tenantID: string }>;
      expect(rel).toHaveLength(1);
      expect(rel[0].relation).toBe('uses');
      expect(rel[0].tenantID).toBe('acme');

      const model = (
        await mongoService.execute({ action: 'query', collection: 'Models', query: {} })
      ).result as Array<{ links?: Record<string, number> }>;
      expect(model[0].links?.Datasets).toBe(1);
    });
  });

  it('aggregate cannot leak across tenants even when caller omits a $match', async (t) => {
    if (skipIfBootFailed(t)) return;
    await runWithContext(ctx('acme'), async () => {
      await mongoService.execute({
        action: 'create',
        collection: 'Sales',
        data: [
          { region: 'EU', amount: 100 },
          { region: 'EU', amount: 50 },
        ],
      });
    });
    await runWithContext(ctx('contoso'), async () => {
      await mongoService.execute({
        action: 'create',
        collection: 'Sales',
        data: [{ region: 'EU', amount: 999 }],
      });
    });
    await runWithContext(ctx('acme'), async () => {
      const r = await mongoService.execute({
        action: 'aggregate',
        collection: 'Sales',
        pipeline: [{ $group: { _id: '$region', total: { $sum: '$amount' } } }],
      });
      const rows = r.result as Array<{ _id: string; total: number }>;
      expect(rows).toEqual([{ _id: 'EU', total: 150 }]); // contoso's 999 must NOT be included
    });
  });

  it('update wraps a plain object in $set automatically', async (t) => {
    if (skipIfBootFailed(t)) return;
    await runWithContext(ctx('acme'), async () => {
      const ins = await mongoService.execute({
        action: 'create',
        collection: 'Models',
        data: { name: 'M', status: 'draft' },
      });
      const upd = await mongoService.execute({
        action: 'update',
        collection: 'Models',
        query: { _id: ins.insertedId },
        data: { status: 'active' }, // no $set — should be wrapped automatically
      });
      expect(upd.success).toBe(true);
      expect(upd.modifiedCount).toBe(1);
      const read = await mongoService.execute({
        action: 'query',
        collection: 'Models',
        query: { _id: ins.insertedId },
      });
      expect((read.result as Array<{ status: string }>)[0].status).toBe('active');
    });
  });
});
