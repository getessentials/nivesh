/**
 * Flexible date parsing for upstream feeds (AMFI, niftyindices) whose formats vary and drift.
 * Pure, no I/O. Always returns 'YYYY-MM-DD' or throws.
 */

const MONTH_ABBR: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Accepts 'DD-Mon-YYYY' (AMFI, e.g. '22-Jul-2026'), 'DD-MM-YYYY', or 'YYYY-MM-DD'. */
export function parseFlexibleDate(raw: string): string {
  const s = raw.trim();

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD-Mon-YYYY (AMFI style)
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
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
