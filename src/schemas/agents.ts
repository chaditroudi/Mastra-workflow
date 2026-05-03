import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* MongoDB Agent                                                       */
/* ------------------------------------------------------------------ */

export const MongoActionSchema = z.enum([
  'create', // insert one or many documents
  'query', // find with filter / projection / sort / limit
  'update', // updateOne or updateMany
  'delete', // deleteOne / deleteMany
  'link', // create a relationship doc joining two collections (transactional)
  'aggregate', // run an aggregation pipeline
]);
export type MongoAction = z.infer<typeof MongoActionSchema>;

export const MongoToolInputSchema = z.object({
  action: MongoActionSchema,
  collection: z.string().min(1),
  /** find/update filter or aggregation $match equivalent. */
  query: z.record(z.string(), z.unknown()).optional(),
  /** payload for create/update; for `link`, must be { from, to, fromId, toId, relation? }. */
  data: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).optional(),
  /** find options. */
  options: z
    .object({
      projection: z.record(z.string(), z.unknown()).optional(),
      sort: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().max(1000).optional(),
      skip: z.number().int().nonnegative().optional(),
      /** updateMany vs updateOne, etc. */
      many: z.boolean().optional(),
      /** upsert for update. */
      upsert: z.boolean().optional(),
    })
    .optional(),
  /** aggregation pipeline (used when action === "aggregate"). */
  pipeline: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type MongoToolInput = z.infer<typeof MongoToolInputSchema>;

export const MongoToolOutputSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  insertedId: z.string().optional(),
  matchedCount: z.number().optional(),
  modifiedCount: z.number().optional(),
  deletedCount: z.number().optional(),
  error: z.string().optional(),
});
export type MongoToolOutput = z.infer<typeof MongoToolOutputSchema>;

/* ------------------------------------------------------------------ */
/* Search Agent                                                        */
/* ------------------------------------------------------------------ */

export const SearchToolInputSchema = z.object({
  query: z.string().min(1),
  type: z.enum(['web', 'internal', 'vector']).default('internal'),
  limit: z.number().int().positive().max(50).default(5),
  /** Optional collection to vector-search within (only for type=vector / internal). */
  collection: z.string().optional(),
});
export type SearchToolInput = z.infer<typeof SearchToolInputSchema>;

export const SearchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string().url().optional(),
  score: z.number().optional(),
  source: z.string().optional(),
  /** Arbitrary structured payload — e.g. for internal vector hits. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchToolOutputSchema = z.object({
  results: z.array(SearchResultSchema),
});
export type SearchToolOutput = z.infer<typeof SearchToolOutputSchema>;

/* ------------------------------------------------------------------ */
/* Chart Agent                                                         */
/* ------------------------------------------------------------------ */

export const ChartTypeSchema = z.enum(['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar']);
export type ChartType = z.infer<typeof ChartTypeSchema>;

export const ChartDatasetSchema = z.object({
  label: z.string(),
  data: z.array(z.union([z.number(), z.object({ x: z.number(), y: z.number() })])),
  backgroundColor: z.union([z.string(), z.array(z.string())]).optional(),
  borderColor: z.union([z.string(), z.array(z.string())]).optional(),
  borderWidth: z.number().optional(),
});

export const ChartToolInputSchema = z.object({
  chartType: ChartTypeSchema,
  data: z.object({
    labels: z.array(z.union([z.string(), z.number()])),
    datasets: z.array(ChartDatasetSchema).min(1),
  }),
  options: z.record(z.string(), z.unknown()).optional(),
  title: z.string().optional(),
});
export type ChartToolInput = z.infer<typeof ChartToolInputSchema>;

export const ChartToolOutputSchema = z.object({
  /** Chart.js-compatible config object — render client-side or via QuickChart. */
  chartConfig: z.record(z.string(), z.unknown()),
  /** Optional pre-rendered URL (e.g. via QuickChart.io). */
  imageUrl: z.string().url().optional(),
});
export type ChartToolOutput = z.infer<typeof ChartToolOutputSchema>;

/* ------------------------------------------------------------------ */
/* Email Agent                                                         */
/* ------------------------------------------------------------------ */

export const EmailToolInputSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email())]),
  subject: z.string().min(1).max(200),
  /** Plain-text body. Markdown is acceptable; the renderer will pass it through. */
  body: z.string().min(1),
  /** Optional URLs to embed (e.g. chart image URLs from a prior step). */
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string().optional(),
      }),
    )
    .optional(),
  /** Reply-to override; defaults to the configured sender. */
  replyTo: z.string().email().optional(),
});
export type EmailToolInput = z.infer<typeof EmailToolInputSchema>;

export const EmailToolOutputSchema = z.object({
  success: z.boolean(),
  /** Provider-issued message id, when available. */
  messageId: z.string().optional(),
  /** True when the message was queued to a stub backend (no real provider configured). */
  stubbed: z.boolean().optional(),
  error: z.string().optional(),
});
export type EmailToolOutput = z.infer<typeof EmailToolOutputSchema>;
