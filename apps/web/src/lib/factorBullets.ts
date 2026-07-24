/**
 * Numbers-only fallback rendering (docs/09 §8: "regenerate once, then fall back to numbers-only
 * display — factor table without prose"). Used whenever `recommendation_items.narrative` is null,
 * and always for the score-breakdown bars regardless of narrative presence.
 */
interface FactorJson {
  momentumReturnPct?: number | null;
  trendReturnPct?: number | null;
  peerReturnCagrPct?: number | null;
  terPct?: number | null;
  aumCr?: number | null;
  trackingDiff1y?: number | null;
  eligibleEtfCount?: number;
  totalAumCr?: number;
  tags?: string[];
  // recommendation_items.factor_json is a free-form JSON blob (docs/05) with many more fields
  // than this module reads — the index signature is what makes it safe to pass the raw parsed
  // object (typed as Record<string, unknown> at the call site) straight through.
  [key: string]: unknown;
}

export function themeFactorBullets(factorJson: FactorJson): string[] {
  const bullets: string[] = [];
  if (typeof factorJson.momentumReturnPct === 'number') bullets.push(`6m momentum: ${factorJson.momentumReturnPct.toFixed(2)}%`);
  if (typeof factorJson.trendReturnPct === 'number') bullets.push(`12m trend: ${factorJson.trendReturnPct.toFixed(2)}%`);
  if (typeof factorJson.eligibleEtfCount === 'number') bullets.push(`${factorJson.eligibleEtfCount} eligible ETF(s), ₹${Math.round(factorJson.totalAumCr ?? 0).toLocaleString('en-IN')} cr AUM`);
  return bullets;
}

export function etfFactorBullets(factorJson: FactorJson): string[] {
  const bullets: string[] = [];
  if (typeof factorJson.trackingDiff1y === 'number') bullets.push(`TD 1y: ${factorJson.trackingDiff1y.toFixed(2)}%`);
  if (typeof factorJson.terPct === 'number') bullets.push(`TER: ${factorJson.terPct.toFixed(2)}%`);
  if (typeof factorJson.aumCr === 'number') bullets.push(`AUM: ₹${Math.round(factorJson.aumCr).toLocaleString('en-IN')} cr`);
  if (typeof factorJson.peerReturnCagrPct === 'number') bullets.push(`3y CAGR: ${factorJson.peerReturnCagrPct.toFixed(2)}%`);
  return bullets;
}

export function factorTags(factorJson: FactorJson): string[] {
  return Array.isArray(factorJson.tags) ? factorJson.tags : [];
}
