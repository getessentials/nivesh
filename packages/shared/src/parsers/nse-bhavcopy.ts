/**
 * Parser for NSE's UDiFF bhavcopy (docs/02 §1 fallback when Yahoo is unreachable — Yahoo
 * blocks data-center IPs more aggressively than residential, docs/07 ENG-3). Verified live
 * 2026-07-23: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_DDMMYYYY_F_0000.csv.zip`
 * (zip; the caller unzips — this module is pure text-in, rows-out). Confirmed ISIN-keyed and
 * matches our seed ISINs exactly (e.g. INF204KB14I2 = NIFTYBEES, INF247L01DJ0 = MODEFENCE).
 *
 * `TtlTrfVal` is the day's true turnover in rupees (verified: TtlTradgVol * ClsPric ≈ TtlTrfVal
 * to within VWAP-vs-close rounding) — more accurate than the close*volume approximation the
 * Yahoo-based primary path has to use, since Yahoo's chart API doesn't expose turnover directly.
 *
 * Matched by header NAME (not position) for tolerance to NSE's historical schema drift.
 */

const REQUIRED_HEADERS = ['TradDt', 'ISIN', 'TckrSymb', 'ClsPric', 'TtlTradgVol', 'TtlTrfVal'] as const;

export interface BhavcopyRow {
  isin: string;
  tickerSymbol: string;
  /** 'YYYY-MM-DD' — TradDt already arrives ISO-formatted in the UDiFF format */
  date: string;
  /** decimal rupees */
  close: number;
  volume: number;
  /** decimal rupees (true turnover, not an approximation) */
  tradedValue: number;
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map((f) => f.trim());
}

export function parseNseBhavcopy(csvText: string): BhavcopyRow[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('NSE bhavcopy CSV has no data rows');

  const header = splitCsvLine(lines[0]!);
  const idx: Record<string, number> = {};
  for (const name of REQUIRED_HEADERS) {
    const i = header.indexOf(name);
    if (i === -1) {
      throw new Error(`NSE bhavcopy schema drift: missing expected column "${name}" in header [${header.join(', ')}]`);
    }
    idx[name] = i;
  }

  // Number('') === 0 in JS (finite!) — an empty CSV field must never silently become a real
  // zero value, so parse only non-empty strings and treat blank as "absent" explicitly.
  const toNumberOrNull = (s: string | undefined): number | null => {
    if (!s || s.length === 0) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const rows: BhavcopyRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]!);
    const isin = fields[idx.ISIN!];
    const close = toNumberOrNull(fields[idx.ClsPric!]);
    const volume = toNumberOrNull(fields[idx.TtlTradgVol!]);
    const tradedValue = toNumberOrNull(fields[idx.TtlTrfVal!]);
    const date = fields[idx.TradDt!];
    if (!isin || !date || close == null || volume == null || tradedValue == null) {
      continue; // malformed row (e.g. derivative/index rows with blank price fields) — skip, don't crash the batch
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`NSE bhavcopy schema drift: TradDt not in YYYY-MM-DD form: "${date}"`);
    }
    rows.push({ isin, tickerSymbol: fields[idx.TckrSymb!] ?? '', date, close, volume, tradedValue });
  }
  return rows;
}
