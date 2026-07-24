import { describe, expect, it } from 'vitest';
import { parseAmfiNavAll } from '../src/parsers/amfi.ts';

// Shape verified live against portal.amfiindia.com/spages/NAVAll.txt (Phase 0, 2026-07-23).
const FIXTURE = [
  'Open Ended Schemes(Other than Fund of Funds Schemes)',
  '',
  'Aditya Birla Sun Life Mutual Fund',
  '',
  'Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date',
  '149293;INF209KB11D8;-;Aditya Birla Sun Life Nifty IT ETF;42.1234;22-Jul-2026',
  '999999;INF000000000;INF000000001;Some Reinvestment Scheme;100.5000;22-Jul-2026',
  '888888;INF000000002;-;Suspended Scheme;N.A.;22-Jul-2026',
  '',
  'Nippon India Mutual Fund',
  '',
  '140084;INF204KB14I2;-;Nippon India ETF Nifty 50 BeES;273.0943;22-Jul-2026',
  'garbage;not;a;valid;row', // 5 fields, malformed
].join('\n');

describe('parseAmfiNavAll', () => {
  it('extracts only well-formed, priced data rows', () => {
    const { rows } = parseAmfiNavAll(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      schemeCode: '149293',
      isinGrowth: 'INF209KB11D8',
      isinReinvestment: null, // '-' normalized to null
      schemeName: 'Aditya Birla Sun Life Nifty IT ETF',
      nav: 42.1234,
      date: '2026-07-22',
    });
    expect(rows[1].isinReinvestment).toBe('INF000000001');
    expect(rows[2].schemeCode).toBe('140084');
    expect(rows[2].nav).toBe(273.0943);
  });

  it('counts unpriced (N.A.) rows separately, never as a parsed row', () => {
    const { rows, unpricedCount } = parseAmfiNavAll(FIXTURE);
    expect(unpricedCount).toBe(1);
    expect(rows.some((r) => r.schemeCode === '888888')).toBe(false);
  });

  it('skips section headers, blank lines, the column header, and malformed lines', () => {
    const { skippedLineCount } = parseAmfiNavAll(FIXTURE);
    // 4 blank lines + 3 fund-house section headers + 1 column-header line + 1 garbage
    // 5-field line = 9 (the N.A. row is counted separately as unpriced, not skipped)
    expect(skippedLineCount).toBe(9);
  });

  it('normalizes "-" to null for both ISIN columns independently', () => {
    const text = '1;-;-;X;10.00;22-Jul-2026';
    const { rows } = parseAmfiNavAll(text);
    expect(rows[0]).toMatchObject({ isinGrowth: null, isinReinvestment: null });
  });
});
