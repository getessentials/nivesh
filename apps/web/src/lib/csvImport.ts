/**
 * Portfolio CSV import hardening (docs/09 §6): UTF-8 only, <=1MB, <=5000 rows, strict schema,
 * all-or-nothing; sequence-validated against existing lots (no negative positions, ever); re-import
 * dedup against existing transactions.
 */
import Papa from 'papaparse';
import { z } from 'zod';
import { computeRemainingLots, type ChargeConfigRow, type AssetClass } from '@niveshetf/engine';
import type { TransactionRow, EtfRow } from '@/types/db';

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 5_000;

const CsvRowSchema = z.object({
  isin: z.string().min(1).optional(),
  yahoo_symbol: z.string().min(1).optional(),
  side: z.enum(['buy', 'sell']),
  qty: z.coerce.number().int().positive(),
  price_paise: z.coerce.bigint().positive().optional(),
  price_rupees: z.coerce.number().positive().optional(),
  traded_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected 'YYYY-MM-DD'"),
}).refine((r) => r.isin || r.yahoo_symbol, { message: 'each row needs either isin or yahoo_symbol' })
  .refine((r) => r.price_paise !== undefined || r.price_rupees !== undefined, { message: 'each row needs either price_paise or price_rupees' });

export interface ParsedCsvRow {
  rowNumber: number; // 1-based, matches what a user sees in a spreadsheet (header = row 1)
  etfId: number;
  side: 'buy' | 'sell';
  qty: number;
  pricePaise: bigint;
  tradedOn: string;
  isDuplicate: boolean;
}

export interface CsvImportError {
  rowNumber: number | null; // null = file-level error (size/encoding), not a specific row
  message: string;
}

export interface CsvImportResult {
  ok: boolean;
  rows: ParsedCsvRow[];
  error: CsvImportError | null;
}

function resolveEtfId(row: z.infer<typeof CsvRowSchema>, etfs: readonly EtfRow[]): number | null {
  if (row.isin) return etfs.find((e) => e.isin === row.isin)?.id ?? null;
  if (row.yahoo_symbol) return etfs.find((e) => e.yahoo_symbol === row.yahoo_symbol)?.id ?? null;
  return null;
}

/** Parses, validates, and sequence-checks a CSV file. All-or-nothing: the first error found
 *  rejects the entire file (docs/09 §6) — nothing is partially accepted. */
export async function parseAndValidateCsv(
  file: File,
  existingTransactions: readonly TransactionRow[],
  etfs: readonly EtfRow[],
  chargeConfigs: readonly ChargeConfigRow[],
  overrides: readonly ChargeConfigRow[]
): Promise<CsvImportResult> {
  if (file.size > MAX_CSV_BYTES) {
    return { ok: false, rows: [], error: { rowNumber: null, message: `File is ${(file.size / 1e6).toFixed(2)}MB, exceeds the 1MB limit.` } };
  }

  let text: string;
  try {
    const buffer = await file.arrayBuffer();
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, rows: [], error: { rowNumber: null, message: 'File is not valid UTF-8 text.' } };
  }

  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    return { ok: false, rows: [], error: { rowNumber: (parsed.errors[0]!.row ?? 0) + 2, message: parsed.errors[0]!.message } };
  }
  if (parsed.data.length > MAX_CSV_ROWS) {
    return { ok: false, rows: [], error: { rowNumber: null, message: `File has ${parsed.data.length} rows, exceeds the ${MAX_CSV_ROWS} limit.` } };
  }

  const rows: ParsedCsvRow[] = [];
  for (let i = 0; i < parsed.data.length; i++) {
    const rowNumber = i + 2; // header is row 1
    const raw = parsed.data[i]!;
    const result = CsvRowSchema.safeParse(raw);
    if (!result.success) {
      return { ok: false, rows: [], error: { rowNumber, message: result.error.issues[0]?.message ?? 'invalid row' } };
    }
    const etfId = resolveEtfId(result.data, etfs);
    if (etfId === null) {
      return { ok: false, rows: [], error: { rowNumber, message: `no matching ETF for isin=${result.data.isin ?? ''} yahoo_symbol=${result.data.yahoo_symbol ?? ''}` } };
    }
    const pricePaise = result.data.price_paise ?? BigInt(Math.round((result.data.price_rupees ?? 0) * 100));

    const isDuplicate = existingTransactions.some(
      (t) => t.etf_id === etfId && t.side === result.data.side && t.qty === result.data.qty &&
        BigInt(t.price_paise) === pricePaise && t.traded_on === result.data.traded_on
    );

    rows.push({ rowNumber, etfId, side: result.data.side, qty: result.data.qty, pricePaise, tradedOn: result.data.traded_on, isDuplicate });
  }

  // Sequence validation (docs/09 §6): simulate existing + new transactions per ETF and reject the
  // whole file if any sell would exceed FIFO-available quantity on its trade date.
  const etfById = new Map(etfs.map((e) => [e.id, e]));
  const err = validateSequence(rows, existingTransactions, etfById, chargeConfigs, overrides);
  if (err) return { ok: false, rows: [], error: err };

  return { ok: true, rows, error: null };
}

/**
 * Shared by `parseAndValidateCsv` (full parsed set, before the user excludes any rows) and
 * `revalidateForImport` (the exact post-exclusion subset actually being inserted) — the same
 * simulation must run against BOTH, since a user unchecking a row (e.g. an auto-flagged
 * "probable duplicate") can turn a validated set into an invalid one (docs/09 §6, security review
 * finding: "validated row-set and inserted row-set can diverge, defeating the oversell guard").
 */
function validateSequence(
  rowsToImport: readonly ParsedCsvRow[],
  existingTransactions: readonly TransactionRow[],
  etfById: Map<number, EtfRow>,
  chargeConfigs: readonly ChargeConfigRow[],
  overrides: readonly ChargeConfigRow[]
): CsvImportError | null {
  const byEtf = new Map<number, ParsedCsvRow[]>();
  for (const r of rowsToImport) {
    const arr = byEtf.get(r.etfId) ?? [];
    arr.push(r);
    byEtf.set(r.etfId, arr);
  }
  for (const [etfId, newRows] of byEtf) {
    const etf = etfById.get(etfId);
    if (!etf) continue;
    const existingForEtf = existingTransactions.filter((t) => t.etf_id === etfId);
    const combined = [
      ...existingForEtf.map((t) => ({ id: `existing-${t.id}`, side: t.side, qty: t.qty, pricePaise: BigInt(t.price_paise), tradedOn: t.traded_on, createdAt: t.created_at })),
      // Same-day new rows all get an identical synthetic createdAt, so the engine's chronological
      // tie-break falls through to comparing these ids as plain strings — zero-pad the row number
      // (MAX_CSV_ROWS=5000 fits in 6 digits) so that string order matches numeric/file order,
      // otherwise e.g. "import-row-15" would sort before "import-row-2".
      ...newRows.map((r) => ({ id: `import-row-${String(r.rowNumber).padStart(6, '0')}`, side: r.side, qty: r.qty, pricePaise: r.pricePaise, tradedOn: r.tradedOn, createdAt: `${r.tradedOn}T00:00:00.000Z` })),
    ];
    try {
      computeRemainingLots(combined, etf.asset_class as AssetClass, chargeConfigs as ChargeConfigRow[], overrides as ChargeConfigRow[]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const match = message.match(/import-row-(\d+)/);
      if (match) return { rowNumber: Number(match[1]), message };
      // The failure landed on an existing transaction (not a new row) — a new row for this ETF
      // rearranged the FIFO sequence enough to invalidate it. Identify the ETF and the candidate
      // new rows rather than reporting a row number that doesn't exist in the file.
      const newRowNumbers = newRows.map((r) => r.rowNumber).join(', ');
      return {
        rowNumber: null,
        message: `${etf.name}: importing row(s) ${newRowNumbers} would conflict with this ETF's existing transaction history (${message})`,
      };
    }
  }
  return null;
}

/** Re-runs sequence validation against exactly the rows the user is about to import (i.e. after
 *  they've excluded some, such as auto-flagged duplicates) — must be called immediately before
 *  the actual insert, since `parseAndValidateCsv` only validated the full, pre-exclusion set. */
export function revalidateForImport(
  rowsToImport: readonly ParsedCsvRow[],
  existingTransactions: readonly TransactionRow[],
  etfs: readonly EtfRow[],
  chargeConfigs: readonly ChargeConfigRow[],
  overrides: readonly ChargeConfigRow[]
): CsvImportError | null {
  const etfById = new Map(etfs.map((e) => [e.id, e]));
  return validateSequence(rowsToImport, existingTransactions, etfById, chargeConfigs, overrides);
}
