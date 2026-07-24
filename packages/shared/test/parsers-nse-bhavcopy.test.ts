import { describe, expect, it } from 'vitest';
import { parseNseBhavcopy } from '../src/parsers/nse-bhavcopy.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Real 2-row excerpt of the live UDiFF bhavcopy for 2026-07-22, fetched and verified in Phase 0
// (https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260722_F_0000.csv.zip).
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bhavcopy-2026-07-22.csv'),
  'utf8'
);

describe('parseNseBhavcopy', () => {
  it('parses real NSE UDiFF rows, keyed by ISIN', () => {
    const rows = parseNseBhavcopy(FIXTURE);
    expect(rows).toHaveLength(2);

    const niftybees = rows.find((r) => r.isin === 'INF204KB14I2');
    expect(niftybees).toMatchObject({
      isin: 'INF204KB14I2', tickerSymbol: 'NIFTYBEES', date: '2026-07-22',
      close: 273.36, volume: 4687320, tradedValue: 1282349160.05,
    });

    const modefence = rows.find((r) => r.isin === 'INF247L01DJ0');
    expect(modefence).toMatchObject({
      isin: 'INF247L01DJ0', tickerSymbol: 'MODEFENCE', date: '2026-07-22',
      close: 103.28, volume: 921590, tradedValue: 95423698.04,
    });
  });

  it('turnover is internally consistent with volume*close to within VWAP rounding', () => {
    const rows = parseNseBhavcopy(FIXTURE);
    for (const r of rows) {
      const approx = r.volume * r.close;
      expect(Math.abs(approx - r.tradedValue) / r.tradedValue).toBeLessThan(0.01); // within 1%
    }
  });

  it('throws a schema-drift error when a required column is missing', () => {
    const csv = 'TradDt,ISIN,TckrSymb,ClsPric,TtlTradgVol\n2026-07-22,X,Y,1,1';
    expect(() => parseNseBhavcopy(csv)).toThrow(/schema drift/i);
  });

  it('skips malformed data rows (e.g. blank price fields) without crashing the batch', () => {
    const header = 'TradDt,ISIN,TckrSymb,ClsPric,TtlTradgVol,TtlTrfVal';
    const blankRow = '2026-07-22,INF000000000,X,,,'; // blank ClsPric/volume/turnover
    const goodRow = '2026-07-22,INF204KB14I2,NIFTYBEES,273.36,4687320,1282349160.05';
    const rows = parseNseBhavcopy([header, blankRow, goodRow].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0].isin).toBe('INF204KB14I2');
  });

  it('throws when TradDt is not ISO-formatted (drift from the documented UDiFF shape)', () => {
    const header = 'TradDt,ISIN,TckrSymb,ClsPric,TtlTradgVol,TtlTrfVal';
    const row = '22-Jul-2026,INF204KB14I2,NIFTYBEES,273.36,4687320,1282349160.05';
    expect(() => parseNseBhavcopy([header, row].join('\n'))).toThrow(/schema drift/i);
  });
});
