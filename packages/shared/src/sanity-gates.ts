/**
 * Ingestion integrity gates (docs/09 §5): value > 0, |day-over-day move| <= a configurable
 * bound (default 20%), no future dates, no non-monotonic dates. A row failing any gate is
 * quarantined by the caller (never upserted) — this module only judges, it does not write.
 */

export type SanityFailureReason =
  | 'nonpositive'
  | 'future_date'
  | 'non_monotonic_date'
  | `jump>${number}%`;

export interface SanityCheckResult {
  ok: boolean;
  reason?: SanityFailureReason;
}

export interface PreviousObservation {
  /** 'YYYY-MM-DD' */
  date: string;
  value: number;
}

export interface SanityCheckInput {
  value: number;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'YYYY-MM-DD' — the ingestion run's as-of date; a row dated after this is rejected. */
  today: string;
  previous?: PreviousObservation;
  /** Day-over-day move bound as a percent, e.g. 20 = 20%. Default 20 (docs/09 §5). */
  maxMovePct?: number;
}

export function checkTimeSeriesRow(input: SanityCheckInput): SanityCheckResult {
  const { value, date, today, previous, maxMovePct = 20 } = input;

  if (!(value > 0)) return { ok: false, reason: 'nonpositive' };
  if (date > today) return { ok: false, reason: 'future_date' };

  if (previous) {
    if (date < previous.date) return { ok: false, reason: 'non_monotonic_date' };
    if (date > previous.date) {
      const movePct = Math.abs(value / previous.value - 1) * 100;
      if (movePct > maxMovePct) return { ok: false, reason: `jump>${maxMovePct}%` };
    }
    // date === previous.date: benign re-upsert of the same trading day, no move check.
  }

  return { ok: true };
}
