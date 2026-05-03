import { MongoClient, type Db, type ClientSession, type ReadConcern, type WriteConcern } from 'mongodb';
import { logger } from '../utils/logger.js';
import { TransientDbError, classifyMongoError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';

let client: MongoClient | null = null;

export type TenancyStrategy = 'shared' | 'isolated';

export interface DbConfig {
  uri: string;
  /** For "shared" strategy: the single DB name used. For "isolated": prefix used as `${prefix}_${tenantId}`. */
  dbPrefix: string;
  strategy: TenancyStrategy;
}

export function loadDbConfig(): DbConfig {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const strategy = (process.env.TENANCY_STRATEGY ?? 'shared') as TenancyStrategy;
  if (strategy !== 'shared' && strategy !== 'isolated') {
    throw new Error(`Invalid TENANCY_STRATEGY: ${strategy}`);
  }
  return {
    uri,
    dbPrefix: process.env.MONGODB_DB_PREFIX ?? 'app',
    strategy,
  };
}

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;

  const cfg = loadDbConfig();
  client = new MongoClient(cfg.uri, {
    // Sensible defaults — driver retries reads/writes that are safe to retry.
    retryReads: true,
    retryWrites: true,
    // Server selection / connection timeouts kept tight so transient failures
    // bubble up quickly to the application-level retry loop.
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 10_000,
    maxPoolSize: 50,
  });

  await withRetry(() => client!.connect(), {
    label: 'mongo.connect',
    maxAttempts: 5,
    baseDelayMs: 500,
    shouldRetry: () => true,
  }).catch((err) => {
    client = null;
    throw new TransientDbError('Failed to connect to MongoDB', err);
  });

  // Surface connection-level errors instead of letting them go silent.
  client.on('error', (err) => logger.error({ err }, 'mongo client error'));
  client.on('serverHeartbeatFailed', (e) => logger.debug({ e }, 'heartbeat failed'));

  logger.info({ uri: redactUri(cfg.uri) }, 'connected to MongoDB');
  return client;
}

/** Resolve the right Db handle for a given tenant. */
export async function getDbForTenant(tenantId: string): Promise<Db> {
  if (!tenantId) throw new Error('tenantId is required to resolve a DB');
  const c = await getMongoClient();
  const cfg = loadDbConfig();
  const dbName = cfg.strategy === 'isolated' ? `${cfg.dbPrefix}_${sanitize(tenantId)}` : cfg.dbPrefix;
  return c.db(dbName);
}

/**
 * Run `fn` inside a MongoDB transaction with strong defaults: snapshot read
 * concern, majority write concern, and automatic retry on TransientTransactionError
 * and UnknownTransactionCommitResult labels (the official driver pattern).
 */
export async function runTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  opts: { readConcern?: ReadConcern; writeConcern?: WriteConcern } = {},
): Promise<T> {
  const c = await getMongoClient();
  const session = c.startSession();
  try {
    let out!: T;
    await session.withTransaction(
      async () => {
        out = await fn(session);
      },
      {
        readConcern: opts.readConcern ?? { level: 'snapshot' },
        writeConcern: opts.writeConcern ?? { w: 'majority', wtimeoutMS: 5000 },
        readPreference: 'primary',
      },
    );
    return out;
  } catch (err) {
    throw classifyMongoError(err);
  } finally {
    await session.endSession();
  }
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    logger.info('mongo client closed');
  }
}

function sanitize(s: string): string {
  // Mongo db names can't contain /\. " $ * < > : | ?
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 38);
}

function redactUri(uri: string): string {
  return uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}
