/**
 * Effective-dated config resolution (docs/04 §1). The engine NEVER guesses: a sell date/asset
 * class with zero or more-than-one matching row is a data error and throws — pre-FA2024 regimes
 * or a malformed seed must surface loudly, not silently produce a wrong number.
 */
import type { AssetClass, ChargeConfigRow, TaxConfigRow } from './types.ts';

export function resolveTaxConfig(
  configs: readonly TaxConfigRow[],
  assetClass: AssetClass,
  sellDate: string,
  buyDate: string
): TaxConfigRow {
  const matches = configs.filter((c) =>
    c.assetClass === assetClass &&
    c.effectiveFrom <= sellDate && (c.effectiveTo === null || sellDate <= c.effectiveTo) &&
    (c.acquiredFrom === null || c.acquiredFrom <= buyDate) &&
    (c.acquiredTo === null || buyDate <= c.acquiredTo)
  );
  if (matches.length === 0) {
    throw new Error(
      `no tax_config row resolves for assetClass=${assetClass} sellDate=${sellDate} buyDate=${buyDate} ` +
      `(pre-FA2024 regimes are out of scope — see docs/04 §4.0)`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous tax_config resolution (${matches.length} overlapping rows) for ` +
      `assetClass=${assetClass} sellDate=${sellDate} buyDate=${buyDate} — the seed has overlapping ranges`
    );
  }
  return matches[0]!;
}

/**
 * Returns one row per charge_key applicable to `tradedOn` and `assetClass`: `overrides` (if
 * given, a user's `user_charges_overrides`) replace the broker-profile row for the same
 * charge_key (docs/04 §1 "per-user overrides ... take precedence").
 */
export function resolveChargeRows(
  brokerConfigs: readonly ChargeConfigRow[],
  assetClass: AssetClass,
  tradedOn: string,
  overrides: readonly ChargeConfigRow[] = []
): ChargeConfigRow[] {
  const dateMatches = (c: ChargeConfigRow) =>
    c.assetClass === assetClass &&
    c.effectiveFrom <= tradedOn && (c.effectiveTo === null || tradedOn <= c.effectiveTo);

  const byKey = new Map<string, ChargeConfigRow>();
  for (const row of brokerConfigs.filter(dateMatches)) {
    if (byKey.has(row.chargeKey)) {
      throw new Error(`ambiguous charges_config resolution for charge_key=${row.chargeKey} assetClass=${assetClass} tradedOn=${tradedOn}`);
    }
    byKey.set(row.chargeKey, row);
  }
  for (const row of overrides.filter(dateMatches)) {
    byKey.set(row.chargeKey, row); // override always wins, no ambiguity check needed
  }
  const rows = [...byKey.values()];
  if (rows.length === 0) {
    // Unlike resolveTaxConfig (which always expects exactly one row), a charge_key can
    // legitimately be absent for an asset class (e.g. no STT on gold) — but ZERO rows for the
    // WHOLE asset class/date is a seed gap, not a legitimate absence, and must not silently
    // compute charges of 0 (understating tax and overstating net proceeds with no diagnostic —
    // resolveTaxConfig's own comment: "NEVER guesses ... must surface loudly").
    throw new Error(
      `no charges_config rows resolve at all for assetClass=${assetClass} tradedOn=${tradedOn} ` +
      `— this is almost certainly a config/seed gap, not a legitimate zero-charge asset class`
    );
  }
  return rows;
}
