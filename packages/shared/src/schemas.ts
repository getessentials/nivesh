/**
 * Zod schemas validating rows immediately before they cross into a Postgres upsert. bigint
 * paise values are carried as decimal-digit strings on the wire (PostgREST/postgres-js accept
 * numeric strings for `bigint` columns; JS `bigint` doesn't round-trip through JSON directly).
 */
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const paiseString = z.string().regex(/^-?\d+$/, 'expected an integer string (paise)');

export const EtfPriceRowSchema = z.object({
  etf_id: z.number().int().positive(),
  d: isoDate,
  close_paise: paiseString,
  volume: z.number().int().nonnegative().nullable().optional(),
  traded_value_paise: paiseString.nullable().optional(),
});
export type EtfPriceRow = z.infer<typeof EtfPriceRowSchema>;

export const EtfNavRowSchema = z.object({
  etf_id: z.number().int().positive(),
  d: isoDate,
  nav_paise: paiseString,
});
export type EtfNavRow = z.infer<typeof EtfNavRowSchema>;

export const IndexTriRowSchema = z.object({
  index_name: z.string().min(1),
  d: isoDate,
  value: z.number().positive(),
});
export type IndexTriRow = z.infer<typeof IndexTriRowSchema>;

export const QuarantineRowSchema = z.object({
  job: z.string().min(1),
  natural_key: z.string().min(1),
  raw: z.unknown(),
  reason: z.string().min(1),
});
export type QuarantineRow = z.infer<typeof QuarantineRowSchema>;

export const JobOutcomeSchema = z.object({
  job: z.string().min(1),
  ok: z.boolean(),
  rows: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
});
export type JobOutcome = z.infer<typeof JobOutcomeSchema>;

/** etf_metrics fields refresh-metrics can actually compute from ingested data (docs/02 §4). */
export const EtfMetricsComputedSchema = z.object({
  etf_id: z.number().int().positive(),
  as_of: isoDate,
  adtv_paise: paiseString.nullable(),
  premium_discount_30d: z.number().nullable(),
});
export type EtfMetricsComputed = z.infer<typeof EtfMetricsComputedSchema>;
