/**
 * FIFO lot accounting (docs/04 §1: "FIFO per ISIN per demat account"; docs/09 §6: oversell
 * guard). Pure — the caller supplies one ETF's full transaction history already filtered to a
 * single (user, etf) pair; this module has no notion of users or ISINs.
 */
import { resolveChargeRows } from './config-resolution.ts';
import { computeLegCharges } from './charges.ts';
import { divRoundHalfUp } from './rounding.ts';
import type { AssetClass, ChargeConfigRow, FifoSlice, Lot, Transaction } from './types.ts';

function sortChronological<T extends { tradedOn?: string; buyDate?: string; createdAt: string; id: string }>(
  items: readonly T[],
  dateOf: (item: T) => string
): T[] {
  return [...items].sort((a, b) => {
    const da = dateOf(a), db = dateOf(b);
    if (da !== db) return da < db ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * A lot's real, once-paid deductible buy charges apportioned to a slice of `takeQty` units out
 * of `qtyBeforeSlice` remaining, apportioned against `chargesBeforeSlice` (docs/04 §3). Full
 * consumption of what's currently left (`takeQty === qtyBeforeSlice`) takes the EXACT remainder
 * with no rounding — this is what guarantees exact conservation across any number of separate
 * partial sales spanning one lot's lifetime: only genuinely partial steps round, each against
 * the current (not original) remainder, so the running total can never drift from what was
 * actually paid (verified: independently rounding against the ORIGINAL qty/charges on each of
 * several separate sales can drift the total by ±1 paisa; apportioning against the CURRENT
 * remainder at each step cannot).
 */
export function apportionLotCharges(chargesBeforeSlice: bigint, takeQty: number, qtyBeforeSlice: number): bigint {
  if (takeQty === qtyBeforeSlice) return chargesBeforeSlice;
  return divRoundHalfUp(chargesBeforeSlice * BigInt(takeQty), BigInt(qtyBeforeSlice));
}

/**
 * Replays a chronological transaction history and returns the CURRENT remaining lots (buy lots
 * net of all historical FIFO-consuming sells, in original buy order). Throws on oversell — a
 * sell that would consume more than is available at that point in the sequence — which is the
 * same guard docs/09 §6 requires for transaction inserts, buy-row deletes/edits, and CSV import
 * (all of them reduce to "does replaying this sequence ever go negative").
 *
 * Each lot's deductible buy-side charges are computed ONCE, at buy time, from the buy date's
 * effective charge config (docs/04 §3), then decremented via `apportionLotCharges` as each
 * historical sell consumes part of the lot — in lockstep with `qty` — so the remaining-charges
 * figure returned for a still-open lot is always exactly consistent with what a future sale of
 * it will apportion (tax.ts's `computeSellPlan` uses the identical function on the resulting
 * `FifoSlice`, so history-replay and new-sale apportionment can never disagree).
 */
export function computeRemainingLots(
  transactions: readonly Transaction[],
  assetClass: AssetClass,
  brokerChargeConfigs: readonly ChargeConfigRow[],
  chargeOverrides: readonly ChargeConfigRow[] = []
): Lot[] {
  const ordered = sortChronological(transactions, (t) => t.tradedOn);
  const queue: Lot[] = [];

  for (const txn of ordered) {
    if (txn.side === 'buy') {
      const buyChargeRows = resolveChargeRows(brokerChargeConfigs, assetClass, txn.tradedOn, chargeOverrides);
      const buyLegCharges = computeLegCharges(buyChargeRows, 'buy', BigInt(txn.qty) * txn.pricePaise);
      queue.push({
        id: txn.id, qty: txn.qty, buyPricePaise: txn.pricePaise, buyDate: txn.tradedOn, createdAt: txn.createdAt,
        deductibleBuyChargesPaise: buyLegCharges.deductiblePaise,
      });
      continue;
    }
    // sell: consume FIFO from the front, apportioning each consumed lot's charges as we go
    let remaining = txn.qty;
    let i = 0;
    while (remaining > 0 && i < queue.length) {
      const lot = queue[i]!;
      const take = Math.min(remaining, lot.qty);
      const attributedCharges = apportionLotCharges(lot.deductibleBuyChargesPaise, take, lot.qty);
      lot.qty -= take;
      lot.deductibleBuyChargesPaise -= attributedCharges;
      remaining -= take;
      if (lot.qty === 0) queue.splice(i, 1); else i++;
    }
    if (remaining > 0) {
      throw new Error(
        `FIFO oversell at transaction ${txn.id} (traded ${txn.tradedOn}): sell of ${txn.qty} exceeds ` +
        `available quantity by ${remaining} units at that point in the sequence`
      );
    }
  }
  return queue;
}

/**
 * Slices a NEW sell of `sellQty` against the CURRENT remaining lots (from computeRemainingLots
 * or maintained externally), FIFO order, without mutating the input. Used by the sell planner
 * for both real and hypothetical ("what if I sell") sells (docs/04 §1, docs/01 §3.4). Each
 * slice carries the lot's qty/charges as they stood immediately before this slice, so the
 * caller (tax.ts) apportions via the same `apportionLotCharges` rule used during history replay.
 */
export function sliceFifo(remainingLots: readonly Lot[], sellQty: number): FifoSlice[] {
  const sorted = sortChronological(remainingLots, (l) => l.buyDate);
  const slices: FifoSlice[] = [];
  let remaining = sellQty;
  for (const lot of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.qty);
    if (take > 0) {
      slices.push({
        lotId: lot.id, qty: take, buyPricePaise: lot.buyPricePaise, buyDate: lot.buyDate,
        qtyBeforeSlice: lot.qty, deductibleBuyChargesBeforeSlice: lot.deductibleBuyChargesPaise,
      });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    throw new Error(`FIFO oversell: requested ${sellQty} units, only ${sellQty - remaining} available across current lots`);
  }
  return slices;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `new Date('2026-02-30T...')` does NOT produce Invalid Date — it silently rolls over to
 *  2026-03-02. Re-formatting the parsed date and comparing back to the input catches this
 *  (an impossible calendar date will never round-trip), turning a silently-wrong holding-period
 *  or listing-age computation into a loud, specific error instead. */
function parseValidIsoDate(d: string, label: string): Date {
  if (!ISO_DATE_RE.test(d)) throw new Error(`${label}: expected 'YYYY-MM-DD', got: ${d}`);
  const parsed = new Date(`${d}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== d) {
    throw new Error(`${label}: not a real calendar date (silently rolled over): ${d}`);
  }
  return parsed;
}

/**
 * Holding period in whole months from `from` to `to` (calendar-month based; a period starting
 * on the 5th completes a month on the 5th of the following month, not before). Shared by
 * docs/04's LTCG classification (monthsHeld) and docs/03 §3.1's G2 listing-duration gate
 * (gates.ts) — a single implementation so the two can never silently desync.
 */
export function monthsBetween(from: string, to: string): number {
  const f = parseValidIsoDate(from, 'monthsBetween "from"');
  const t = parseValidIsoDate(to, 'monthsBetween "to"');
  let months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth());
  if (t.getUTCDate() < f.getUTCDate()) months -= 1;
  return months;
}

/** Holding period in whole months from buyDate to sellDate (docs/04's 12-month LTCG threshold). */
export function monthsHeld(buyDate: string, sellDate: string): number {
  return monthsBetween(buyDate, sellDate);
}
