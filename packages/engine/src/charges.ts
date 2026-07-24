/**
 * Per-leg charge computation (docs/04 §3, docs/08 §6). GST's base is fixed by convention
 * (docs/05 charges_config comment): the 'gst' row's pct applies to the sum of the UNROUNDED
 * brokerage + txn + sebi bases of the same order — never stamp duty, STT, or the flat DP charge
 * (DP's fixture value already includes its own GST, docs/04 §3 charges table).
 */
import { chargeFromPct, gstOnUnroundedBases, scaleDecimalToBigInt } from './rounding.ts';
import type { ChargeConfigRow, ChargeLineItem, LegCharges } from './types.ts';

const GST_BASE_KEYS = new Set(['brokerage', 'txn', 'sebi']);

export function computeLegCharges(
  chargeRows: readonly ChargeConfigRow[],
  side: 'buy' | 'sell',
  considerationPaise: bigint
): LegCharges {
  const applicable = chargeRows.filter((c) => c.side === side || c.side === 'both');
  const gstRow = applicable.find((c) => c.chargeKey === 'gst');
  const nonGstRows = applicable.filter((c) => c.chargeKey !== 'gst');

  const lineItems: ChargeLineItem[] = [];
  for (const row of nonGstRows) {
    const amount = row.kind === 'pct'
      ? chargeFromPct(considerationPaise, row.value)
      : scaleDecimalToBigInt(row.value, 0); // flat_paise: already an integer paise amount
    lineItems.push({ chargeKey: row.chargeKey, amountPaise: amount, taxDeductible: row.taxDeductible });
  }

  if (gstRow) {
    const gstBaseEntries = nonGstRows
      .filter((r) => GST_BASE_KEYS.has(r.chargeKey) && r.kind === 'pct')
      .map((r) => ({ basePaise: considerationPaise, pctPercent: r.value }));
    const gstAmount = gstOnUnroundedBases(gstBaseEntries, gstRow.value);
    lineItems.push({ chargeKey: 'gst', amountPaise: gstAmount, taxDeductible: gstRow.taxDeductible });
  }

  const totalPaise = lineItems.reduce((s, li) => s + li.amountPaise, 0n);
  const deductiblePaise = lineItems.reduce((s, li) => s + (li.taxDeductible ? li.amountPaise : 0n), 0n);
  return { lineItems, totalPaise, deductiblePaise };
}
