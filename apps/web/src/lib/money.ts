/**
 * Display-only money formatting (paise -> Indian rupee strings). All arithmetic on money happens
 * server-side in integer paise (CLAUDE.md money invariant) — this module only ever FORMATS
 * already-computed paise values for display, never computes a rupee figure itself.
 */

const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const INR_FORMATTER_PAISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/** Formats integer paise (bigint, number, or numeric string) as a whole-rupee INR string, e.g.
 *  "₹1,25,000". Rounds to the nearest rupee — use `formatPaiseExact` where paisa precision matters
 *  (e.g. tax figures). */
export function formatPaise(paise: bigint | number | string): string {
  const rupees = Number(paise) / 100;
  return INR_FORMATTER.format(rupees);
}

/** Formats integer paise with full paisa precision, e.g. "₹1,25,000.46" — for tax/charges figures
 *  where docs/04 requires the paisa-precise number to be shown alongside any rounded one. */
export function formatPaiseExact(paise: bigint | number | string): string {
  const rupees = Number(paise) / 100;
  return INR_FORMATTER_PAISE.format(rupees);
}

/** Formats a fraction (0.075) as a percentage string ("7.5%"). Used for weight_target/actual,
 *  which the schema stores as a fraction of X_spendable, not a percentage (docs/05). */
export function formatPct(fraction: number | null | undefined, decimals = 1): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Formats a plain percentage value (already 0-100 scale, e.g. a return or TER) with a sign. */
export function formatSignedPct(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}
