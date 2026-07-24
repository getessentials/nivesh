/**
 * Parser for niftyindices TRI history CSVs — used both by the automated ingest-tri attempt and
 * the manual CSV upload path in Settings, which docs/02 §3 promotes to first-class (the
 * niftyindices POST endpoints were observed erroring as of 2026-07-23; schema drift is expected
 * and tolerated by column-NAME matching rather than column position).
 *
 * One file = one index's history. Header row column names are matched case-insensitively
 * against known synonyms; an unrecognized header throws (surfaced as a quarantine-worthy
 * schema-drift error, never silently misread).
 */
import { parseFlexibleDate } from './dates.ts';

export interface TriRow {
  /** 'YYYY-MM-DD' */
  date: string;
  value: number;
}

const DATE_HEADER_SYNONYMS = ['date', 'index date'];
// 'total returns index' (plural) is the exact header niftyindices' own CSV export uses
// (verified 2026-07-24 against a real downloaded file) — 'total return index' (singular) kept
// too in case of drift, never remove either.
const VALUE_HEADER_SYNONYMS = ['close', 'closing value', 'index value', 'tri', 'total return index', 'total returns index'];

function splitCsvLine(line: string): string[] {
  // niftyindices exports are plain comma-separated with no embedded commas in date/numeric
  // fields — a full RFC4180 parser is unneeded for this source.
  return line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
}

export function parseTriCsv(csvText: string): TriRow[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('TRI CSV has no data rows');

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const dateIdx = header.findIndex((h) => DATE_HEADER_SYNONYMS.includes(h));
  const valueIdx = header.findIndex((h) => VALUE_HEADER_SYNONYMS.includes(h));
  if (dateIdx === -1 || valueIdx === -1) {
    throw new Error(
      `TRI CSV schema drift: could not find date/value columns in header [${header.join(', ')}]`
    );
  }

  const rows: TriRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]!);
    const rawDate = fields[dateIdx];
    const rawValue = fields[valueIdx];
    if (!rawDate || !rawValue) continue;
    const value = Number(rawValue.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    rows.push({ date: parseFlexibleDate(rawDate), value });
  }
  return rows;
}
