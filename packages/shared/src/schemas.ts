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

/**
 * The MANUAL_ONLY_FIELDS (docs/02 §4) an owner submits via admin-submit-metrics — no clean free
 * API exists for these. Bounds are sanity ceilings to catch fat-finger typos (e.g. "15" instead
 * of "1.5"), deliberately looser than the eligibility gate thresholds in packages/engine/gates.ts
 * (TER<=1%, TE<=2%) — a value can be sane-but-ineligible and still needs to be accepted here so
 * the plan can honestly report WHY an ETF was excluded, rather than the submission being rejected
 * before the gate ever sees it.
 */
export const EtfMetricsManualSchema = z.object({
  etf_id: z.number().int().positive(),
  as_of: isoDate,
  aum_cr: z.number().positive().max(1_000_000),
  ter_pct: z.number().min(0).max(5),
  tracking_error_1y: z.number().min(0).max(20),
  tracking_diff_1y: z.number().min(-20).max(20),
  tracking_diff_3y: z.number().min(-20).max(20).nullable().optional(),
  tracking_diff_5y: z.number().min(-20).max(20).nullable().optional(),
});
export type EtfMetricsManual = z.infer<typeof EtfMetricsManualSchema>;
