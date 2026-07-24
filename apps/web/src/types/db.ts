/**
 * Row shapes for the tables/views this app reads or writes (docs/05-database-schema.sql).
 * Field names match the DB columns verbatim (snake_case) — no translation layer, so a schema
 * change is a one-place diff against the migration file. `bigint` columns arrive over PostgREST
 * as numeric strings; convert with BigInt() at the point of use, never with Number() (paisa
 * precision matters — CLAUDE.md money invariant).
 */

export type RiskAppetite = 'conservative' | 'moderate' | 'aggressive';
export type NonEquitySleeve = 'gold' | 'debt';
export type AssetClass = 'equity' | 'gold' | 'silver' | 'debt' | 'intl';
export type PipelineStatus =
  | 'pending' | 'research' | 'gated' | 'theme_ranked' | 'etf_ranked' | 'allocated' | 'narrated'
  | 'done' | 'failed' | 'superseded';

export interface ProfileRow {
  user_id: string;
  dob: string;
  risk: RiskAppetite;
  default_amount_paise: string;
  tax_slab_pct: string;
  broker_profile: string;
  core_index: string;
  non_equity_sleeve: NonEquitySleeve;
  created_at: string;
}

export interface FyExemptionInputRow {
  user_id: string;
  fy: string;
  used_elsewhere_paise: string;
  entered_on: string;
}

export interface IndexRow {
  name: string;
  tri_source: 'niftyindices' | 'nav_proxy' | 'manual' | 'none';
  notes: string | null;
  proxy_etf_id: number | null;
}

export interface ThemeRow {
  key: string;
  name: string;
  investable: boolean;
  proxy_note: string | null;
  benchmark_index: string | null;
}

export interface EtfRow {
  id: number;
  isin: string;
  name: string;
  yahoo_symbol: string;
  amfi_scheme_code: string | null;
  underlying_index: string;
  asset_class: AssetClass;
  intl: boolean;
  ltcg_months: number | null;
  exit_load_pct: string;
  exit_load_days: number;
  listed_on: string | null;
  active: boolean;
}

export interface ThemeEtfMapRow {
  theme_key: string;
  etf_id: number;
}

export interface UserChargesOverrideRow {
  user_id: string;
  charge_key: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell' | 'both';
  kind: 'pct' | 'flat_paise';
  value: string;
  tax_deductible: boolean;
}

export interface TransactionRow {
  id: string;
  user_id: string;
  etf_id: number;
  side: 'buy' | 'sell';
  qty: number;
  price_paise: string;
  charges_paise: string;
  traded_on: string;
  source: 'manual' | 'plan' | 'csv' | 'broker';
  run_id: string | null;
  created_at: string;
}

export interface HoldingRow {
  user_id: string;
  etf_id: number;
  qty: number;
}

export interface ThemeResearchRow {
  research_month: string;
  payload: { candidates: Array<{ theme_key: string; thesis: string; policy_tailwind_score: number; sources: string[] }> };
  model: string;
  forced: boolean;
  created_at: string;
}

export interface MonthlyRunRow {
  id: string;
  user_id: string;
  run_month: string;
  seq: number;
  amount_paise: string;
  carry_in_paise: string;
  residual_paise: string | null;
  research_month: string | null;
  status: PipelineStatus;
  fail_reason: string | null;
  stage_attempts: number;
  llm_cost_usd: string;
  created_at: string;
}

export interface RunAcknowledgementRow {
  user_id: string;
  run_id: string;
  kind: 'reviewed' | 'superseded_ack';
  at: string;
}

export interface RecommendationItemRow {
  id: string;
  run_id: string;
  level: 'theme' | 'etf';
  theme_key: string | null;
  etf_id: number | null;
  rank: number;
  score: string;
  factor_json: Record<string, unknown>;
  narrative: string | null;
  alloc_paise: string | null;
  units: number | null;
  weight_target: string | null;
  weight_actual: string | null;
}

export interface RunEtfGateResultRow {
  run_id: string;
  etf_id: number;
  theme_key: string;
  eligible: boolean;
  failure_reasons: string[];
}

export interface FeedbackScoreRow {
  user_id: string;
  scope: 'theme' | 'etf';
  ref: string;
  adj: string;
  as_of: string;
  detail: Record<string, unknown>;
}

export interface JobRunRow {
  id: number;
  job: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  rows: number | null;
  error: string | null;
}

export interface EtfPriceRow { etf_id: number; d: string; close_paise: string; volume: number | null; traded_value_paise: string | null }
export interface EtfNavRow { etf_id: number; d: string; nav_paise: string }
export interface IndexTriRow { index_name: string; d: string; value: string }
export interface EtfMetricsRow {
  etf_id: number;
  as_of: string;
  aum_cr: string | null;
  ter_pct: string | null;
  tracking_error_1y: string | null;
  tracking_diff_1y: string | null;
  tracking_diff_3y: string | null;
  tracking_diff_5y: string | null;
  adtv_paise: string | null;
  premium_discount_30d: string | null;
  source: string;
}

export interface TaxConfigRow {
  id: number;
  asset_class: AssetClass;
  effective_from: string;
  effective_to: string | null;
  acquired_from: string | null;
  acquired_to: string | null;
  stcg_mode: 'flat' | 'slab';
  stcg_rate_pct: string | null;
  ltcg_months: number;
  ltcg_rate_pct: string;
  ltcg_exemption_paise: string;
  cess_pct: string;
}

export interface ChargesConfigRow {
  broker_profile: string;
  charge_key: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell' | 'both';
  kind: 'pct' | 'flat_paise';
  value: string;
  tax_deductible: boolean;
  effective_from: string;
  effective_to: string | null;
}

export interface NseHolidayRow {
  d: string;
  label: string | null;
}

export interface MetricsReviewQueueRow {
  etf_id: number;
  as_of: string;
  missing_fields: string[];
  resolved: boolean;
}

export interface IngestQuarantineRow {
  id: number;
  job: string;
  natural_key: string;
  raw: Record<string, unknown>;
  reason: string;
  resolved: boolean;
  created_at: string;
}
