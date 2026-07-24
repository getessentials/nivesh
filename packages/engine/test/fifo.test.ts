import { describe, expect, it } from 'vitest';
import { computeRemainingLots, sliceFifo, monthsHeld, monthsBetween, apportionLotCharges } from '../src/fifo.ts';
import { GOLDEN_CHARGES_CONFIG } from './fixtures/golden-config.ts';
import type { Transaction } from '../src/types.ts';

function txn(id: string, side: 'buy' | 'sell', qty: number, price: number, tradedOn: string, createdAt = tradedOn): Transaction {
  return { id, side, qty, pricePaise: BigInt(price), tradedOn, createdAt };
}

// 100 units @ 25000 paise = 2,500,000 consideration -> deductible buy charges 466 (docs/04 E1,
// verified earlier in charges.test.ts). 100 units @ 28000 paise = 2,800,000 consideration ->
// deductible buy charges 521 (txn 83 + sebi 3 + stamp 420 + gst 15).
const remainingLots = (transactions: Transaction[]) =>
  computeRemainingLots(transactions, 'equity', GOLDEN_CHARGES_CONFIG);

describe('computeRemainingLots', () => {
  it('a single buy with no sells remains fully, carrying its real deductible buy charges', () => {
    const lots = remainingLots([txn('b1', 'buy', 100, 25000, '2026-01-01')]);
    expect(lots).toEqual([{
      id: 'b1', qty: 100, buyPricePaise: 25000n, buyDate: '2026-01-01', createdAt: '2026-01-01',
      deductibleBuyChargesPaise: 466n,
    }]);
  });

  it('a partial sell reduces qty AND deductible charges together, in lockstep (docs/04 E1 shape)', () => {
    const lots = remainingLots([
      txn('b1', 'buy', 100, 25000, '2026-01-05'),
      txn('s1', 'sell', 60, 31000, '2026-02-20'),
    ]);
    // 60 sold: apportionLotCharges(466, 60, 100) = divRoundHalfUp(466*60,100) = 280 attributed to
    // the sold 60; the remaining 40 units keep 466-280 = 186 of the lot's original charges.
    expect(lots).toEqual([{
      id: 'b1', qty: 40, buyPricePaise: 25000n, buyDate: '2026-01-05', createdAt: '2026-01-05',
      deductibleBuyChargesPaise: 186n,
    }]);
  });

  it('a full sell removes the lot entirely', () => {
    const lots = remainingLots([
      txn('b1', 'buy', 100, 25000, '2026-01-05'),
      txn('s1', 'sell', 100, 31000, '2026-02-20'),
    ]);
    expect(lots).toEqual([]);
  });

  it('FIFO consumes the earliest lot first across multiple buys (docs/04 E4 shape)', () => {
    const lots = remainingLots([
      txn('b1', 'buy', 100, 25000, '2025-05-01'), // older lot
      txn('b2', 'buy', 100, 28000, '2026-04-01'), // newer lot
      txn('s1', 'sell', 150, 31000, '2026-07-01'),
    ]);
    // 100 from b1 (fully consumed) + 50 from b2 (partially consumed): 50 sold from b2 attributes
    // apportionLotCharges(521, 50, 100) = 261 to the sold half, leaving 521-261 = 260 on the lot.
    expect(lots).toEqual([{
      id: 'b2', qty: 50, buyPricePaise: 28000n, buyDate: '2026-04-01', createdAt: '2026-04-01',
      deductibleBuyChargesPaise: 260n,
    }]);
  });

  it('conserves charges EXACTLY across multiple separate sells of the same lot over time ' +
     '(the exact bug this design fixes: apportioning against a fixed ORIGINAL qty/charges on ' +
     'each independent sell can drift the total by rounding; apportioning against the CURRENT ' +
     'remainder at each step cannot)', () => {
    // Lot b2 (100 units, 521 paisa deductible charges) sold as 50, then the remaining 50, in
    // TWO separate transactions replayed within one history.
    const lots = remainingLots([
      txn('b1', 'buy', 100, 25000, '2025-01-01'), // filler lot consumed first, keeps b2 isolated
      txn('b2', 'buy', 100, 28000, '2025-02-01'),
      txn('s1', 'sell', 100, 31000, '2025-06-01'), // consumes all of b1
      txn('s2', 'sell', 50, 31000, '2025-09-01'),  // first partial sale of b2 (50 of 100)
      txn('s3', 'sell', 50, 31000, '2026-01-01'),  // final sale of b2's remaining 50 (full consumption of what's left)
    ]);
    expect(lots).toEqual([]); // both lots now fully sold

    // Reconstruct what each of s2/s3 would have apportioned, using the SAME function tax.ts
    // would call, to confirm the two attributions sum to EXACTLY 521 (not 520 or 522).
    const s2Attributed = apportionLotCharges(521n, 50, 100); // qtyBeforeSlice=100 (b2's full original)
    const s3Attributed = apportionLotCharges(521n - s2Attributed, 50, 50); // full consumption of the remainder
    expect(s2Attributed + s3Attributed).toBe(521n);
  });

  it('processes out-of-order input chronologically by tradedOn, not array order', () => {
    const lots = remainingLots([
      txn('s1', 'sell', 50, 31000, '2026-03-01'),
      txn('b1', 'buy', 100, 25000, '2026-01-05'),
    ]);
    expect(lots[0]).toMatchObject({ id: 'b1', qty: 50 });
  });

  it('throws on oversell (no negative positions, ever — docs/09 §6)', () => {
    expect(() => remainingLots([
      txn('b1', 'buy', 100, 25000, '2026-01-05'),
      txn('s1', 'sell', 150, 31000, '2026-02-20'),
    ])).toThrow(/oversell/i);
  });

  it('same-day transactions tie-break by createdAt, then id', () => {
    const lots = remainingLots([
      txn('b2', 'buy', 50, 26000, '2026-01-05', '2026-01-05T10:00:00Z'),
      txn('b1', 'buy', 50, 25000, '2026-01-05', '2026-01-05T09:00:00Z'),
      txn('s1', 'sell', 50, 31000, '2026-02-01', '2026-02-01T00:00:00Z'),
    ]);
    // b1 (created earlier same day) is consumed first, leaving b2 fully intact
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ id: 'b2', qty: 50 });
  });
});

describe('apportionLotCharges', () => {
  it('full consumption of the current remainder takes it exactly, no rounding', () => {
    expect(apportionLotCharges(521n, 100, 100)).toBe(521n);
    expect(apportionLotCharges(37n, 5, 5)).toBe(37n);
  });
  it('partial consumption rounds half-up against the current (not original) basis', () => {
    expect(apportionLotCharges(521n, 50, 100)).toBe(261n); // divRoundHalfUp(521*50,100)
  });
});

describe('sliceFifo — docs/04 E4 shape (lot1=100 14mo old, lot2=100 3mo old, sell 150)', () => {
  const lot1 = { id: 'lot1', qty: 100, buyPricePaise: 25000n, buyDate: '2025-05-01', createdAt: '2025-05-01', deductibleBuyChargesPaise: 466n };
  const lot2 = { id: 'lot2', qty: 100, buyPricePaise: 28000n, buyDate: '2026-04-01', createdAt: '2026-04-01', deductibleBuyChargesPaise: 521n };

  it('slices 100 from the older lot and 50 from the newer lot, carrying pre-slice lot state', () => {
    const slices = sliceFifo([lot1, lot2], 150);
    expect(slices).toEqual([
      { lotId: 'lot1', qty: 100, buyPricePaise: 25000n, buyDate: '2025-05-01', qtyBeforeSlice: 100, deductibleBuyChargesBeforeSlice: 466n },
      { lotId: 'lot2', qty: 50, buyPricePaise: 28000n, buyDate: '2026-04-01', qtyBeforeSlice: 100, deductibleBuyChargesBeforeSlice: 521n },
    ]);
  });

  it('does not mutate the input lots array', () => {
    const lots = [{ ...lot1 }];
    sliceFifo(lots, 50);
    expect(lots[0]!.qty).toBe(100); // unchanged
  });

  it('throws on a hypothetical oversell against current holdings', () => {
    expect(() => sliceFifo([{ ...lot1 }], 150)).toThrow(/oversell/i);
  });
});

describe('monthsHeld / monthsBetween (shared by LTCG classification and gate G2)', () => {
  it('monthsHeld delegates to the same monthsBetween used by gates.ts', () => {
    expect(monthsHeld('2026-01-05', '2026-02-20')).toBe(monthsBetween('2026-01-05', '2026-02-20'));
  });
  it('E1: 05-Jan-2026 to 20-Feb-2026 is 1 month (well under 12 -> STCG)', () => {
    expect(monthsHeld('2026-01-05', '2026-02-20')).toBe(1);
  });
  it('E2: 05-Jan-2026 to 10-Feb-2027 is 13 months (over 12 -> LTCG)', () => {
    expect(monthsHeld('2026-01-05', '2027-02-10')).toBe(13);
  });
  it('exactly 12 months on the anniversary date counts as 12 (LTCG boundary)', () => {
    expect(monthsHeld('2025-01-05', '2026-01-05')).toBe(12);
  });
  it('one day short of the anniversary counts as 11 months (still STCG)', () => {
    expect(monthsHeld('2025-01-05', '2026-01-04')).toBe(11);
  });
  it('rejects an impossible calendar date instead of silently rolling it over ' +
     '(JS Date would turn 2026-02-30 into 2026-03-02 with no error)', () => {
    expect(() => monthsHeld('2026-02-30', '2027-01-01')).toThrow(/not a real calendar date/);
  });
  it('rejects a malformed date string', () => {
    expect(() => monthsHeld('not-a-date', '2027-01-01')).toThrow(/expected 'YYYY-MM-DD'/);
  });
});
