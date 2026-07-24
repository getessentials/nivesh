import { describe, expect, it } from 'vitest';
import { parseTriCsv } from '../src/parsers/tri-csv.ts';

describe('parseTriCsv', () => {
  it('parses a canonical niftyindices-style export', () => {
    const csv = [
      'Index Name,Date,Open,High,Low,Close',
      'NIFTY 50 TRI,22-Jul-2026,30000.00,30150.25,29950.10,30100.50',
      'NIFTY 50 TRI,21-Jul-2026,29900.00,30050.00,29850.00,30000.00',
    ].join('\n');
    const rows = parseTriCsv(csv);
    expect(rows).toEqual([
      { date: '2026-07-22', value: 30100.5 },
      { date: '2026-07-21', value: 30000 },
    ]);
  });

  it('matches header names case-insensitively and tolerates a synonym set', () => {
    const csv = ['date,Index Value', '2026-07-22,30100.5'].join('\n');
    expect(parseTriCsv(csv)).toEqual([{ date: '2026-07-22', value: 30100.5 }]);
  });

  it('strips surrounding quotes from quoted fields (no embedded commas, per source docs)', () => {
    const csv = ['Date,Close', '"22-Jul-2026","30100.50"'].join('\n');
    expect(parseTriCsv(csv)).toEqual([{ date: '2026-07-22', value: 30100.5 }]);
  });

  it('throws a schema-drift error when no recognizable date/value columns exist', () => {
    const csv = ['Foo,Bar', '1,2'].join('\n');
    expect(() => parseTriCsv(csv)).toThrow(/schema drift/i);
  });

  it('throws on a header-only file with no data rows', () => {
    expect(() => parseTriCsv('Date,Close')).toThrow(/no data rows/i);
  });

  it('skips rows with an unparseable value rather than throwing', () => {
    const csv = ['Date,Close', '2026-07-22,N/A', '2026-07-21,30000'].join('\n');
    expect(parseTriCsv(csv)).toEqual([{ date: '2026-07-21', value: 30000 }]);
  });
});
