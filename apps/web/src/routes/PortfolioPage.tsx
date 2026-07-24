import { useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolioValuation } from '@/hooks/usePortfolioValuation';
import { useGetTaxConfigQuery, useGetFeedbackScoresQuery } from '@/store/api';
import { resolveLtcgMonths, rotationSummary, type RotationSummary } from '@/lib/rotation';
import { formatPaise, formatPaiseExact } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { AddLotDialog } from '@/components/portfolio/AddLotDialog';
import { CsvImportDialog } from '@/components/portfolio/CsvImportDialog';
import { LotDrawer } from '@/components/portfolio/LotDrawer';
import { FeedbackBadge } from '@/components/performance/FeedbackBadge';
import { Disclaimer } from '@/components/Disclaimer';
import type { HoldingValuation } from '@/lib/holdingsCompute';
import type { EtfRow, FeedbackScoreRow, TaxConfigRow } from '@/types/db';

const TODAY = new Date().toISOString().slice(0, 10);

function toEngineTaxConfigs(rows: readonly TaxConfigRow[]) {
  return rows.map((c) => ({
    assetClass: c.asset_class, effectiveFrom: c.effective_from, effectiveTo: c.effective_to,
    acquiredFrom: c.acquired_from, acquiredTo: c.acquired_to, stcgMode: c.stcg_mode,
    stcgRatePct: c.stcg_rate_pct ? Number(c.stcg_rate_pct) : null, ltcgMonths: c.ltcg_months,
    ltcgRatePct: Number(c.ltcg_rate_pct), ltcgExemptionPaise: BigInt(c.ltcg_exemption_paise), cessPct: Number(c.cess_pct),
  }));
}

/** Per-holding days-to-LTCG + rotation advice (docs/01 §3.3/§4), or null if it can't be resolved
 *  yet (tax_config not loaded, or no tax_config row for this asset class). */
function holdingRotationInfo(
  holding: HoldingValuation & { etf: EtfRow },
  taxConfigs: readonly TaxConfigRow[] | undefined,
  etfScoresDesc: readonly FeedbackScoreRow[]
): RotationSummary | null {
  if (!taxConfigs) return null;
  try {
    const ltcgMonths = resolveLtcgMonths(toEngineTaxConfigs(taxConfigs), holding.etf.asset_class, holding.etf.ltcg_months, TODAY);
    return rotationSummary(holding.lots, ltcgMonths, TODAY, etfScoresDesc);
  } catch {
    return null;
  }
}

export default function PortfolioPage() {
  const { session } = useAuth();
  const userId = session!.user.id;
  const valuation = usePortfolioValuation();
  const { data: taxConfigs } = useGetTaxConfigQuery();
  const { data: feedbackScores } = useGetFeedbackScoresQuery(userId);
  const [addLotOpen, setAddLotOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedHolding, setSelectedHolding] = useState<(HoldingValuation & { etf: EtfRow }) | null>(null);

  // Full as_of-desc history per ETF (not just the latest) — `consecutiveLagRuns` needs the run
  // sequence, not a single snapshot.
  const scoresByEtf = useMemo(() => {
    const map = new Map<number, FeedbackScoreRow[]>();
    for (const s of feedbackScores ?? []) {
      if (s.scope !== 'etf') continue;
      const etfId = Number(s.ref);
      const arr = map.get(etfId) ?? [];
      arr.push(s);
      map.set(etfId, arr);
    }
    return map;
  }, [feedbackScores]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>Import CSV</Button>
          <Button onClick={() => setAddLotOpen(true)}>Add lot</Button>
        </div>
      </div>

      {valuation.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : valuation.holdings.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No holdings yet. Import a CSV, add a lot manually, or mark bought against a monthly plan.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ETF</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Avg cost</TableHead>
                <TableHead>Invested</TableHead>
                <TableHead>Current value</TableHead>
                <TableHead>Unrealized P&amp;L</TableHead>
                <TableHead>Days to LTCG</TableHead>
                <TableHead>Feedback / rotation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {valuation.holdings.map((h) => {
                const avgCostPaise = h.qty > 0 ? h.investedPaise / BigInt(h.qty) : 0n;
                const etfScoresDesc = scoresByEtf.get(h.etfId) ?? [];
                const rotation = holdingRotationInfo(h, taxConfigs, etfScoresDesc);
                return (
                  <TableRow key={h.etfId} className="cursor-pointer" onClick={() => setSelectedHolding(h)}>
                    <TableCell className="font-medium">{h.etf.name}</TableCell>
                    <TableCell className="tabular-nums">{h.qty}</TableCell>
                    <TableCell className="tabular-nums">{formatPaiseExact(avgCostPaise)}</TableCell>
                    <TableCell className="tabular-nums">{formatPaiseExact(h.investedPaise)}</TableCell>
                    <TableCell className="tabular-nums">{formatPaiseExact(h.currentValuePaise)}</TableCell>
                    <TableCell className={`tabular-nums ${h.unrealizedPaise >= 0n ? 'text-success' : 'text-destructive'}`}>
                      {h.unrealizedPaise >= 0n ? '+' : ''}{formatPaise(h.unrealizedPaise)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {!rotation ? '—'
                        : rotation.ltcgUnreachable ? 'N/A (slab)'
                        : rotation.nearest.daysToLtcg <= 0 ? 'Past LTCG'
                        : `${rotation.nearest.daysToLtcg}d`}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <FeedbackBadge score={etfScoresDesc[0]} />
                        {rotation?.proposeRotation && (
                          <Badge variant={rotation.advice === 'rotate_now' ? 'destructive' : 'outline'} className="w-fit">
                            {rotation.advice === 'rotate_now' ? 'Consider rotating' : 'Hold to LTCG, then rotate'}
                            {' '}({rotation.consecutiveLagRuns} consecutive LAG runs)
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AddLotDialog open={addLotOpen} onOpenChange={setAddLotOpen} />
      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <LotDrawer holding={selectedHolding} etf={selectedHolding?.etf} open={selectedHolding !== null} onOpenChange={(open) => !open && setSelectedHolding(null)} />

      <Disclaimer />
    </div>
  );
}
