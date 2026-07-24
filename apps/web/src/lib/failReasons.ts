/**
 * Human-readable `monthly_runs.fail_reason` copy (docs/01 §4.1: "never raw error strings"). Single
 * source of truth shared by Dashboard and Plan — they previously carried divergent, contradictory
 * wording for the same reason key.
 *
 * `ingest_missing` is the only stable, literal fail_reason the pipeline sets on purpose
 * (`stage-research/index.ts`: set once the ingest deadline — 12:00 IST the day after the run
 * date — has passed with required data still missing). Before that deadline the run just stays
 * `pending` and nudges the ingesters; it does NOT retry automatically once `fail_reason` is set —
 * everything else that reaches `fail_reason` is a free-text "most recent error" scratch value
 * (`run-driver`'s `stage retries exhausted` fallback, or a caught exception message), so it's
 * deliberately not enumerated here — the generic fallback below covers it.
 */
export const FAIL_REASON_LABELS: Record<string, string> = {
  ingest_missing: "Market data for this run wasn't available by the cutoff (12:00 IST the next day), so it could not proceed. It won't retry automatically — try \"Run now\" once data has caught up, or wait for next month's run.",
};

export const FAIL_REASON_FALLBACK = 'This run could not complete — see run history in Settings for details.';

export function failReasonLabel(reason: string | null): string {
  return (reason && FAIL_REASON_LABELS[reason]) ?? FAIL_REASON_FALLBACK;
}
