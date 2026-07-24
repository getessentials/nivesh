/**
 * Flexible date parsing for upstream feeds (AMFI, niftyindices) whose formats vary and drift.
 * Pure, no I/O. Always returns 'YYYY-MM-DD' or throws.
 */

const MONTH_ABBR: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH_ABBR_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(MONTH_ABBR).map(([abbr, num]) => [num, abbr[0]!.toUpperCase() + abbr.slice(1)])
);

/** Accepts 'DD-Mon-YYYY' (AMFI, e.g. '22-Jul-2026'), 'DD Mon YYYY' (niftyindices'
 *  getTotalReturnIndexString response, e.g. '23 Jul 2026'), 'DD-MM-YYYY', or 'YYYY-MM-DD'. */
export function parseFlexibleDate(raw: string): string {
  const s = raw.trim();

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD-Mon-YYYY (AMFI style) or DD Mon YYYY (niftyindices JSON style)
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/.exec(s);
  if (m) {
    const mon = MONTH_ABBR[m[2]!.toLowerCase()];
    if (!mon) throw new Error(`unrecognized month abbreviation in date: ${raw}`);
    return `${m[3]}-${mon}-${m[1]!.padStart(2, '0')}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;

  throw new Error(`unrecognized date format: ${raw}`);
}

/** Inverse of the 'DD-Mon-YYYY' leg above — niftyindices' request payload (not response) wants
 *  dates in exactly this form, e.g. '2026-07-24' -> '24-Jul-2026'. */
export function isoDateToDDMonYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`isoDateToDDMonYYYY: not an ISO date: ${iso}`);
  const mon = MONTH_ABBR_REVERSE[m[2]!];
  if (!mon) throw new Error(`isoDateToDDMonYYYY: unrecognized month number: ${m[2]}`);
  return `${m[3]}-${mon}-${m[1]}`;
}
