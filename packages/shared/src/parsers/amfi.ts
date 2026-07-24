/**
 * Parser for AMFI's daily NAV master file (docs/02 §2): plain-text, semicolon-delimited, with
 * fund-house section header lines and a column-header line interspersed among data rows.
 * Verified live shape (Phase 0, 2026-07-23): fetched via a 302 redirect to
 * portal.amfiindia.com/spages/NAVAll.txt — fetching that redirect is the caller's job (this
 * module is pure text-in, rows-out).
 *
 * Line shape (6 semicolon-delimited fields):
 *   Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 */
import { parseFlexibleDate } from './dates.ts';

export interface AmfiRow {
  schemeCode: string;
  isinGrowth: string | null;
  isinReinvestment: string | null;
  schemeName: string;
  /** decimal rupees, e.g. 273.0943 */
  nav: number;
  /** 'YYYY-MM-DD' */
  date: string;
}

export interface AmfiParseResult {
  rows: AmfiRow[];
  /** Lines that had 6 fields but a non-numeric NAV ("N.A." — scheme not priced that day). */
  unpricedCount: number;
  /** Lines skipped outright: blank, AMC section headers, the column-header line itself. */
  skippedLineCount: number;
}

export function parseAmfiNavAll(text: string): AmfiParseResult {
  const rows: AmfiRow[] = [];
  let unpricedCount = 0;
  let skippedLineCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) { skippedLineCount++; continue; }

    const fields = line.split(';');
    if (fields.length !== 6) { skippedLineCount++; continue; } // AMC section header, etc.

    const [schemeCode, isinGrowth, isinReinv, schemeName, navStr, dateStr] =
      fields.map((f) => f.trim());

    if (!/^\d+$/.test(schemeCode ?? '')) { skippedLineCount++; continue; } // the header row itself

    if (!navStr || navStr.toUpperCase() === 'N.A.') { unpricedCount++; continue; }
    const nav = Number(navStr);
    if (!Number.isFinite(nav)) { unpricedCount++; continue; }

    let date: string;
    try {
      date = parseFlexibleDate(dateStr!);
    } catch {
      skippedLineCount++;
      continue;
    }

    const normalizeIsin = (v: string | undefined): string | null =>
      v && v.length > 0 && v !== '-' ? v : null;

    rows.push({
      schemeCode: schemeCode!,
      isinGrowth: normalizeIsin(isinGrowth),
      isinReinvestment: normalizeIsin(isinReinv),
      schemeName: schemeName ?? '',
      nav,
      date,
    });
  }

  return { rows, unpricedCount, skippedLineCount };
}
