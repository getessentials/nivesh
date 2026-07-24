/**
 * stage-allocate (etf_ranked -> allocated): docs/03 §1/§4. Splits X_spendable into core/
 * satellite/non-equity sleeves, applies the one-per-index dedup ACROSS sleeves (docs/03 §3.3),
 * the within-theme 70/30 split on the post-dedup survivors, the bounded-softmax theme weights,
 * and the greedy remainder pass — writing final alloc_paise/units/weight_target/weight_actual
 * onto every recommendation_items row and monthly_runs.residual_paise. Driver-invoked only
 * (docs/09 §2.1).
 *
 * Cross-sleeve merge (docs/03 §1): when the non-equity sleeve's theme (gold/debt_liquid) is ALSO
 * a selected satellite theme, the non-equity paise is added onto that theme's own best-scored
 * post-dedup pick rather than tracked as an independent role — "the same single ETF takes both
 * allocations, one merged line."
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure, chainStage } from '../_shared/pipeline.ts';
import { loadLatestClosePaise } from '../_shared/prices-repo.ts';
import {
  equityPct, coreSharePct, splitSleeves, boundedSoftmax, allocPaiseForWeight, remainderPass,
  oneperIndexDedup, withinThemeSplitPostDedup, type RiskAppetite, type IndexedPick, type ThemedPick, type RemainderPick,
} from '../_shared/engine-lib.ts';
import { firstTradingDayOfMonth } from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RunRow { user_id: string; run_month: string; amount_paise: string; carry_in_paise: string }

async function loadRun(supabase: SupabaseClient, runId: string): Promise<RunRow> {
  const { data, error } = await supabase.from('monthly_runs').select('user_id, run_month, amount_paise, carry_in_paise').eq('id', runId).single();
  if (error) throw new Error(`failed to load run ${runId}: ${error.message}`);
  return data as RunRow;
}

async function loadHolidays(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('nse_holidays').select('d');
  if (error) throw new Error(`failed to load nse_holidays: ${error.message}`);
  return new Set((data as Array<{ d: string }>).map((r) => r.d));
}

interface ProfileRow { dob: string; risk: RiskAppetite; non_equity_sleeve: 'gold' | 'debt' }

async function loadProfile(supabase: SupabaseClient, userId: string): Promise<ProfileRow> {
  const { data, error } = await supabase.from('profiles').select('dob, risk, non_equity_sleeve').eq('user_id', userId).single();
  if (error) throw new Error(`failed to load profile for user ${userId}: ${error.message}`);
  return data as ProfileRow;
}

function ageAt(dobIso: string, asOfIso: string): number {
  const dob = new Date(`${dobIso}T00:00:00.000Z`);
  const asOf = new Date(`${asOfIso}T00:00:00.000Z`);
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthdayThisYear = asOf.getUTCMonth() < dob.getUTCMonth() || (asOf.getUTCMonth() === dob.getUTCMonth() && asOf.getUTCDate() < dob.getUTCDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

interface EtfRankRow { theme_key: string; etf_id: number; rank: number; score: number; factor_json: { terPct: number | null; aumCr: number | null } }

async function loadEtfRankRows(supabase: SupabaseClient, runId: string): Promise<EtfRankRow[]> {
  const { data, error } = await supabase.from('recommendation_items').select('theme_key, etf_id, rank, score, factor_json').eq('run_id', runId).eq('level', 'etf');
  if (error) throw new Error(`failed to load etf recommendation_items for run ${runId}: ${error.message}`);
  return data as EtfRankRow[];
}

interface ThemeRankRow { theme_key: string; rank: number; score: number }

async function loadThemeRankRows(supabase: SupabaseClient, runId: string): Promise<ThemeRankRow[]> {
  const { data, error } = await supabase.from('recommendation_items').select('theme_key, rank, score').eq('run_id', runId).eq('level', 'theme').order('rank');
  if (error) throw new Error(`failed to load theme recommendation_items for run ${runId}: ${error.message}`);
  return data as ThemeRankRow[];
}

async function loadUnderlyingIndexByEtf(supabase: SupabaseClient, etfIds: readonly number[]): Promise<Map<number, string>> {
  if (etfIds.length === 0) return new Map();
  const { data, error } = await supabase.from('etfs').select('id, underlying_index').in('id', etfIds);
  if (error) throw new Error(`failed to load etfs underlying_index: ${error.message}`);
  return new Map((data as Array<{ id: number; underlying_index: string }>).map((r) => [r.id, r.underlying_index]));
}

interface AllocPickRole {
  role: 'core' | 'satellite' | 'non_equity';
  themeKey: string;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'etf_ranked');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not at etf_ranked' });

    try {
      const run = await loadRun(supabase, runId);
      const holidays = await loadHolidays(supabase);
      const runDate = firstTradingDayOfMonth(run.run_month.slice(0, 7), holidays);
      const profile = await loadProfile(supabase, run.user_id);

      const age = ageAt(profile.dob, runDate);
      const eqPct = equityPct(age, profile.risk);
      const coreShare = coreSharePct(profile.risk);
      const nonEquityTheme = profile.non_equity_sleeve === 'gold' ? 'gold' : 'debt_liquid';

      const xSpendablePaise = BigInt(run.amount_paise) + BigInt(run.carry_in_paise);
      const sleeves = splitSleeves(xSpendablePaise, eqPct, coreShare);

      const themeRankRows = await loadThemeRankRows(supabase, runId);
      const etfRankRows = await loadEtfRankRows(supabase, runId);
      const etfRowsByTheme = new Map<string, EtfRankRow[]>();
      for (const r of etfRankRows) {
        const arr = etfRowsByTheme.get(r.theme_key) ?? [];
        arr.push(r);
        etfRowsByTheme.set(r.theme_key, arr);
      }

      const selectedThemeKeys = themeRankRows.map((t) => t.theme_key);
      const nonEquityIsMerged = selectedThemeKeys.includes(nonEquityTheme);

      // ---- Build the flat candidate-pick list for cross-sleeve one-per-index dedup (docs/03 §3.3) ----
      const corePick = (etfRowsByTheme.get('broad_core') ?? []).find((r) => r.rank === 1);
      const nonEquityPick = nonEquityIsMerged ? undefined : (etfRowsByTheme.get(nonEquityTheme) ?? []).find((r) => r.rank === 1);
      const satelliteTop2ByTheme = new Map<string, EtfRankRow[]>();
      for (const themeKey of selectedThemeKeys) satelliteTop2ByTheme.set(themeKey, (etfRowsByTheme.get(themeKey) ?? []).filter((r) => r.rank <= 2));

      const allEtfIds = [
        ...(corePick ? [corePick.etf_id] : []),
        ...(nonEquityPick ? [nonEquityPick.etf_id] : []),
        ...[...satelliteTop2ByTheme.values()].flat().map((r) => r.etf_id),
      ];
      const underlyingIndexByEtf = await loadUnderlyingIndexByEtf(supabase, [...new Set(allEtfIds)]);

      type Candidate = IndexedPick & ThemedPick & AllocPickRole;
      const candidates: Candidate[] = [];
      if (corePick) {
        candidates.push({
          role: 'core', themeKey: 'broad_core', etfId: corePick.etf_id, underlyingIndex: underlyingIndexByEtf.get(corePick.etf_id) ?? '',
          sEtfFinal: corePick.score, terPct: corePick.factor_json.terPct ?? 0, aumCr: corePick.factor_json.aumCr ?? 0,
        });
      }
      if (nonEquityPick) {
        candidates.push({
          role: 'non_equity', themeKey: nonEquityTheme, etfId: nonEquityPick.etf_id, underlyingIndex: underlyingIndexByEtf.get(nonEquityPick.etf_id) ?? '',
          sEtfFinal: nonEquityPick.score, terPct: nonEquityPick.factor_json.terPct ?? 0, aumCr: nonEquityPick.factor_json.aumCr ?? 0,
        });
      }
      for (const [themeKey, rows] of satelliteTop2ByTheme) {
        for (const r of rows) {
          candidates.push({
            role: 'satellite', themeKey, etfId: r.etf_id, underlyingIndex: underlyingIndexByEtf.get(r.etf_id) ?? '',
            sEtfFinal: r.score, terPct: r.factor_json.terPct ?? 0, aumCr: r.factor_json.aumCr ?? 0,
          });
        }
      }

      const dedup = oneperIndexDedup(candidates);
      const survivors = dedup.kept;

      // ---- Theme weights (bounded softmax over selected themes' S_theme_final, docs/03 §4 step 2) ----
      const themeWeights = boundedSoftmax(themeRankRows.map((t) => t.score));
      const themeWeightByKey = new Map(themeRankRows.map((t, i) => [t.theme_key, themeWeights[i]!]));

      // ---- Within-theme split over post-dedup satellite survivors (docs/03 §3.3/§4 step 2) ----
      const satelliteSurvivors = survivors.filter((c) => c.role === 'satellite');
      const withinTheme = withinThemeSplitPostDedup(satelliteSurvivors);

      interface FinalPick { etfId: number; themeKey: string; combinedWeightOfSleeve: number; sleevePaise: bigint; sEtfFinal: number; terPct: number; mergedNonEquity: boolean }
      const finalPicks: FinalPick[] = [];

      const representedThemeKeys = new Set<string>();
      for (const { pick, weight } of withinTheme) {
        const themeWeight = themeWeightByKey.get(pick.themeKey) ?? 0;
        finalPicks.push({
          etfId: pick.etfId, themeKey: pick.themeKey, combinedWeightOfSleeve: themeWeight * weight,
          sleevePaise: sleeves.satellitePaise, sEtfFinal: pick.sEtfFinal, terPct: pick.terPct, mergedNonEquity: false,
        });
        representedThemeKeys.add(pick.themeKey);
      }
      // A theme whose ENTIRE top-2 lost the cross-sleeve one-per-index dedup (docs/03 §3.3) has no
      // entry in finalPicks — its earmarked softmax share of the satellite sleeve must still be
      // accounted for rather than silently vanish (docs/03 §4 step 5: every paisa is spent or
      // reported as residual/carry). Its target share joins the remainder pool directly.
      let unclaimedThemeSharePaise = 0n;
      for (const t of themeRankRows) {
        if (representedThemeKeys.has(t.theme_key)) continue;
        const themeWeight = themeWeightByKey.get(t.theme_key) ?? 0;
        unclaimedThemeSharePaise += allocPaiseForWeight(themeWeight, sleeves.satellitePaise);
      }
      const coreSurvivor = survivors.find((c) => c.role === 'core');
      if (coreSurvivor) {
        finalPicks.push({ etfId: coreSurvivor.etfId, themeKey: 'broad_core', combinedWeightOfSleeve: 1, sleevePaise: sleeves.corePaise, sEtfFinal: coreSurvivor.sEtfFinal, terPct: coreSurvivor.terPct, mergedNonEquity: false });
      }
      const nonEquitySurvivor = survivors.find((c) => c.role === 'non_equity');
      if (nonEquitySurvivor) {
        finalPicks.push({ etfId: nonEquitySurvivor.etfId, themeKey: nonEquityTheme, combinedWeightOfSleeve: 1, sleevePaise: sleeves.nonEquityPaise, sEtfFinal: nonEquitySurvivor.sEtfFinal, terPct: nonEquitySurvivor.terPct, mergedNonEquity: false });
      } else if (nonEquityIsMerged) {
        // Merge onto the merged theme's own top (post-dedup) pick (docs/03 §1 cross-sleeve merge).
        const mergeTarget = finalPicks.find((p) => p.themeKey === nonEquityTheme);
        if (mergeTarget) {
          mergeTarget.mergedNonEquity = true;
          // Tracked as an ADDITIONAL sleeve contribution alongside the satellite one (see
          // targetAllocPaise computation below, which sums both sleeve contributions for a
          // merged pick rather than using a single combinedWeight*sleevePaise formula).
        }
      }

      const etfIdsForPricing = finalPicks.map((p) => p.etfId);
      const priceByEtf = await loadLatestClosePaise(supabase, etfIdsForPricing, runDate);

      // Target (pre-unit-rounding) alloc paise per pick — the one float->paise crossing per
      // sleeve (docs/08 §5). A merged pick sums its satellite-sleeve contribution AND the whole
      // non-equity sleeve.
      const targetAllocPaise = new Map<number, bigint>();
      const targetWeightOfXSpendable = new Map<number, number>();
      for (const p of finalPicks) {
        let alloc = allocPaiseForWeight(p.combinedWeightOfSleeve, p.sleevePaise);
        let weightOfX = (p.combinedWeightOfSleeve * Number(p.sleevePaise)) / Number(xSpendablePaise);
        if (p.mergedNonEquity) {
          alloc += allocPaiseForWeight(1, sleeves.nonEquityPaise);
          weightOfX += Number(sleeves.nonEquityPaise) / Number(xSpendablePaise);
        }
        targetAllocPaise.set(p.etfId, (targetAllocPaise.get(p.etfId) ?? 0n) + alloc);
        targetWeightOfXSpendable.set(p.etfId, (targetWeightOfXSpendable.get(p.etfId) ?? 0) + weightOfX);
      }

      let poolPaise = sleeves.flooringShortfallPaise + unclaimedThemeSharePaise;
      const baseUnitsByEtf = new Map<number, number>();
      for (const p of finalPicks) {
        const price = priceByEtf.get(p.etfId);
        const alloc = targetAllocPaise.get(p.etfId) ?? 0n;
        if (!price || price <= 0n) { poolPaise += alloc; continue; } // no price data — can't buy units; its target paise joins the pool rather than being silently dropped
        const units = alloc / price; // bigint floor division
        baseUnitsByEtf.set(p.etfId, Number(units));
        poolPaise += alloc - units * price;
      }

      const remainderPicks: RemainderPick[] = finalPicks
        .filter((p) => priceByEtf.has(p.etfId) && priceByEtf.get(p.etfId)! > 0n)
        .map((p) => ({
          id: String(p.etfId), pricePaise: priceByEtf.get(p.etfId)!,
          targetWeightOfXSpendable: targetWeightOfXSpendable.get(p.etfId) ?? 0,
          sEtfFinal: p.sEtfFinal, terPct: p.terPct, etfId: p.etfId,
        }));
      const baseAllocForRemainder = remainderPicks.map((p) => (BigInt(baseUnitsByEtf.get(p.etfId) ?? 0) * p.pricePaise));
      const remainder = remainderPass(remainderPicks, baseAllocForRemainder, xSpendablePaise, poolPaise);

      const finalUnitsByEtf = new Map<number, number>();
      remainderPicks.forEach((p, i) => {
        finalUnitsByEtf.set(p.etfId, (baseUnitsByEtf.get(p.etfId) ?? 0) + remainder.extraUnits[i]!);
      });

      // ---- Persist: update every etf-level row's alloc/units/weights; theme-level rows get weight only ----
      for (const [etfId, units] of finalUnitsByEtf) {
        const price = priceByEtf.get(etfId)!;
        const allocPaise = BigInt(units) * price;
        const weightActual = Number(allocPaise) / Number(xSpendablePaise);
        const weightTarget = targetWeightOfXSpendable.get(etfId) ?? 0;
        const themeKeysForEtf = [...new Set(finalPicks.filter((p) => p.etfId === etfId).map((p) => p.themeKey))];
        for (const themeKey of themeKeysForEtf) {
          const { error } = await supabase
            .from('recommendation_items')
            .update({ alloc_paise: allocPaise.toString(), units, weight_target: weightTarget, weight_actual: weightActual })
            .eq('run_id', runId).eq('level', 'etf').eq('theme_key', themeKey).eq('etf_id', etfId);
          if (error) throw new Error(`failed to update allocation for run ${runId} etf ${etfId}: ${error.message}`);
        }
      }
      for (const t of themeRankRows) {
        const themeWeight = themeWeightByKey.get(t.theme_key) ?? 0;
        const weightOfX = (themeWeight * Number(sleeves.satellitePaise)) / Number(xSpendablePaise);
        const { error } = await supabase
          .from('recommendation_items')
          .update({ weight_target: weightOfX, weight_actual: weightOfX })
          .eq('run_id', runId).eq('level', 'theme').eq('theme_key', t.theme_key);
        if (error) throw new Error(`failed to update theme weight for run ${runId} theme ${t.theme_key}: ${error.message}`);
      }

      await completeStage(supabase, runId, 'allocated', { residual_paise: remainder.residualPaise.toString() });
      await chainStage('stage-narrate', { runId });
      return jsonResponse({ ok: true, runId, status: 'allocated', residualPaise: remainder.residualPaise.toString(), capBound: remainder.capBound });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
