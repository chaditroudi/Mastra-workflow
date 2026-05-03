/**
 * Seed script. Populates demo data for two tenants ("acme" and "contoso") so
 * the example workflows return interesting results instead of empty arrays.
 *
 * Run:
 *   npm run seed
 *   npm run seed -- --reset       # drop tenant DBs / wipe tenant docs first
 *   npm run seed -- --tenant=acme # only seed one tenant
 *
 * Idempotent: re-running won't duplicate data because we upsert by name.
 */

import { randomUUID } from 'node:crypto';
import { runWithContext } from './middleware/tenant.js';
import { mongoService } from './services/mongo.service.js';
import { getDbForTenant, closeMongo, loadDbConfig } from './config/database.js';
import { logger } from './utils/logger.js';

export interface TenantSeed {
  tenantId: string;
  models: { name: string; description: string; inputs: string[] }[];
  datasets: { name: string; source: string; description: string; rowCount: number }[];
  sales: { region: string; quarter: string; revenue: number; year: number }[];
  /** name pairs (model, dataset) to link with relation="uses" */
  links: { model: string; dataset: string }[];
}

export const SEEDS: TenantSeed[] = [
  {
    tenantId: 'acme',
    models: [
      {
        name: 'SalesForecast',
        description: 'Quarterly revenue forecast model trained on historical Sales data.',
        inputs: ['year', 'quarter', 'region', 'revenue'],
      },
      {
        name: 'ChurnPredictor',
        description: 'Logistic regression predicting customer churn from usage signals.',
        inputs: ['usage_30d', 'tickets_open', 'plan_tier'],
      },
    ],
    datasets: [
      {
        name: 'sales_data',
        source: 'file://uploads/sales_2024_q1-q4.csv',
        description: 'Aggregated quarterly sales data for 2024 and 2025 across all regions.',
        rowCount: 16,
      },
      {
        name: 'customer_signals',
        source: 's3://acme-prod/customers/signals.parquet',
        description: 'Daily product-usage signals and ticket counts for active customers.',
        rowCount: 250_000,
      },
    ],
    sales: [
      { region: 'NA', quarter: 'Q1', revenue: 120, year: 2025 },
      { region: 'NA', quarter: 'Q2', revenue: 140, year: 2025 },
      { region: 'NA', quarter: 'Q3', revenue: 160, year: 2025 },
      { region: 'NA', quarter: 'Q4', revenue: 200, year: 2025 },
      { region: 'EU', quarter: 'Q1', revenue: 80, year: 2025 },
      { region: 'EU', quarter: 'Q2', revenue: 95, year: 2025 },
      { region: 'EU', quarter: 'Q3', revenue: 110, year: 2025 },
      { region: 'EU', quarter: 'Q4', revenue: 130, year: 2025 },
      { region: 'APAC', quarter: 'Q1', revenue: 50, year: 2025 },
      { region: 'APAC', quarter: 'Q2', revenue: 65, year: 2025 },
      { region: 'APAC', quarter: 'Q3', revenue: 90, year: 2025 },
      { region: 'APAC', quarter: 'Q4', revenue: 120, year: 2025 },
    ],
    links: [
      { model: 'SalesForecast', dataset: 'sales_data' },
      { model: 'ChurnPredictor', dataset: 'customer_signals' },
    ],
  },
  {
    tenantId: 'contoso',
    models: [
      {
        name: 'InventoryOptimizer',
        description: 'Linear program that minimizes warehouse holding cost.',
        inputs: ['sku', 'demand_forecast', 'lead_time'],
      },
    ],
    datasets: [
      {
        name: 'inventory_q3',
        source: 'file://uploads/inventory_q3.csv',
        description: 'Q3 2025 SKU-level inventory snapshot.',
        rowCount: 12_400,
      },
    ],
    sales: [
      { region: 'NA', quarter: 'Q1', revenue: 9999, year: 2025 }, // sentinel — should NEVER show up in acme aggregations
    ],
    links: [{ model: 'InventoryOptimizer', dataset: 'inventory_q3' }],
  },
];

async function seedTenant(seed: TenantSeed, reset: boolean): Promise<void> {
  const ctx = { tenantId: seed.tenantId, userId: 'seeder', roles: ['admin'], requestId: randomUUID() };
  const log = logger.child({ tenantId: seed.tenantId, agent: 'seed' });

  await runWithContext(ctx, async () => {
    if (reset) {
      // Wipe just THIS tenant's documents (in shared mode) or drop the whole
      // DB (in isolated mode). We do this via the service so tenant scoping
      // is always honored — never bypass the abstraction even for seeding.
      log.info('resetting tenant data');
      const cfg = loadDbConfig();
      if (cfg.strategy === 'isolated') {
        const db = await getDbForTenant(seed.tenantId);
        await db.dropDatabase();
      } else {
        for (const col of ['Models', 'Datasets', 'Sales', 'Relationships']) {
          await mongoService.execute({
            action: 'delete',
            collection: col,
            query: {},
            options: { many: true },
          });
        }
      }
    }

    /* ----------------- Models ----------------- */
    const modelIds = new Map<string, string>();
    for (const m of seed.models) {
      // Upsert via update with upsert:true so re-running the seed is idempotent.
      const upd = await mongoService.execute({
        action: 'update',
        collection: 'Models',
        query: { name: m.name },
        data: { name: m.name, description: m.description, inputs: m.inputs },
        options: { upsert: true },
      });
      // Then read back the _id (upsert doesn't return the new id from updateOne).
      const q = await mongoService.execute({
        action: 'query',
        collection: 'Models',
        query: { name: m.name },
        options: { limit: 1 },
      });
      const id = (q.result as { _id: { toString(): string } }[])[0]._id.toString();
      modelIds.set(m.name, id);
      log.info({ name: m.name, id, modified: upd.modifiedCount }, 'model upserted');
    }

    /* ----------------- Datasets --------------- */
    const datasetIds = new Map<string, string>();
    for (const d of seed.datasets) {
      await mongoService.execute({
        action: 'update',
        collection: 'Datasets',
        query: { name: d.name },
        data: { name: d.name, source: d.source, description: d.description, rowCount: d.rowCount },
        options: { upsert: true },
      });
      const q = await mongoService.execute({
        action: 'query',
        collection: 'Datasets',
        query: { name: d.name },
        options: { limit: 1 },
      });
      datasetIds.set(d.name, (q.result as { _id: { toString(): string } }[])[0]._id.toString());
      log.info({ name: d.name }, 'dataset upserted');
    }

    /* ----------------- Sales ------------------ */
    // Wipe-and-replace for time-series-shaped data — simpler and avoids
    // accumulating duplicate rows on re-seed.
    await mongoService.execute({
      action: 'delete',
      collection: 'Sales',
      query: {},
      options: { many: true },
    });
    if (seed.sales.length) {
      await mongoService.execute({
        action: 'create',
        collection: 'Sales',
        data: seed.sales,
      });
      log.info({ rows: seed.sales.length }, 'sales rows inserted');
    }

    /* ----------------- Links ------------------ */
    // Skip if the relationship already exists (tenant-scoped query).
    for (const l of seed.links) {
      const modelId = modelIds.get(l.model);
      const datasetId = datasetIds.get(l.dataset);
      if (!modelId || !datasetId) {
        log.warn({ link: l }, 'skipping link — endpoint missing');
        continue;
      }
      const existing = await mongoService.execute({
        action: 'query',
        collection: 'Relationships',
        query: { from: 'Models', fromId: modelId, to: 'Datasets', toId: datasetId },
        options: { limit: 1 },
      });
      if ((existing.result as unknown[]).length > 0) {
        log.info({ link: l }, 'link already exists');
        continue;
      }
      await mongoService.execute({
        action: 'link',
        collection: 'Relationships',
        data: { from: 'Models', to: 'Datasets', fromId: modelId, toId: datasetId, relation: 'uses' },
      });
      log.info({ link: l }, 'link created');
    }

    /* --------------- Text indexes ------------- */
    // The search service relies on $text indexes for type=internal queries.
    // Creating them here means the search example actually returns hits.
    const db = await getDbForTenant(seed.tenantId);
    const indexes: Record<string, Record<string, 'text'>> = {
      Models: { name: 'text', description: 'text' },
      Datasets: { name: 'text', description: 'text', source: 'text' },
      Sales: { region: 'text', quarter: 'text' },
    };
    for (const [col, fields] of Object.entries(indexes)) {
      try {
        await db.collection(col).createIndex(fields, { name: `${col}_text_idx` });
      } catch (err) {
        // createIndex throws if you try to create a *second* text index with a
        // different field set — harmless on re-seed, log at debug.
        log.debug({ col, err: (err as Error).message }, 'text index already present');
      }
    }
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const reset = args.has('--reset');
  const onlyTenant = [...args].find((a) => a.startsWith('--tenant='))?.split('=')[1];

  const targets = onlyTenant ? SEEDS.filter((s) => s.tenantId === onlyTenant) : SEEDS;
  if (targets.length === 0) {
    logger.error({ onlyTenant }, 'no matching tenant to seed');
    process.exit(1);
  }

  for (const seed of targets) {
    await seedTenant(seed, reset);
  }

  logger.info(
    {
      tenants: targets.map((t) => t.tenantId),
      reset,
    },
    'seed complete',
  );
  await closeMongo();
}

// Only run when invoked directly (not when imported by tests). Detect via
// the URL of the entry script vs this module's URL.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(async (err) => {
    logger.error({ err }, 'seed failed');
    await closeMongo();
    process.exit(1);
  });
}

export { seedTenant, main as runSeed };
