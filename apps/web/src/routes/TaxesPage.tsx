import { useMemo, useState } from 'react';
import { computeRemainingLots, computeSellPlan, type AssetClass, type SellPlanResult } from '@niveshetf/engine';
import { useAuth } from '@/hooks/useAuth';
import {
  useGetTransactionsQuery, useGetEtfsQuery, useGetChargesConfigQuery, useGetUserChargesOverridesQuery,
  useGetProfileQuery, useGetTaxConfigQuery, useGetFyExemptionInputQuery, useUpsertFyExemptionInputMutation,
} from '@/store/api';
import { toEngineChargeConfig, toEngineOverrides, toEngineTransactions } from '@/lib/holdingsCompute';
import { currentFy, fyDateRange } from '@/lib/fiscalYear';
import { replayFyEquitySells, summarizeFyReport } from '@/lib/taxCompute';
import { formatPaise, formatPaiseExact } from '@/lib/money';
import type { TransactionRow } from '@/types/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Disclaimer } from '@/components/Disclaimer';
import { toast } from 'sonner';

export default function TaxesPage() {
  const { session } = useAuth();
  const userId = session!.user.id;
  const fy = currentFy();
  const { start: fyStart, end: fyEnd } = fyDateRange(fy);

  const { data: profile } = useGetProfileQuery(userId);
  const { data: transactions, isLoading: txnsLoading } = useGetTransactionsQuery(userId);
  const { data: etfs, isLoading: etfsLoading } = useGetEtfsQuery();
  const { data: chargesConfig, isLoading: chargesLoading } = useGetChargesConfigQuery(profile?.broker_profile ?? 'discount_default', { skip: !profile });
  const { data: overrides } = useGetUserChargesOverridesQuery(userId);
  const { data: taxConfigs, isLoading: taxConfigLoading } = useGetTaxConfigQuery();
  const { data: fyExemptionInput } = useGetFyExemptionInputQuery({ userId, fy });
  const [upsertFyExemptionInput] = useUpsertFyExemptionInputMutation();

  const [usedElsewhereRupees, setUsedElsewhereRupees] = useState('');
  const effectiveUsedElsewhereRupees = usedElsewhereRupees !== ''
    ? Number(usedElsewhereRupees)
    : fyExemptionInput ? Number(fyExemptionInput.used_elsewhere_paise) / 100 : 0;
  const usedElsewherePaise = BigInt(Math.round(effectiveUsedElsewhereRupees * 100));

  const [selectedEtfId, setSelectedEtfId] = useState<number | null>(null);
  const [sellQty, setSellQty] = useState('');
  const [sellPriceRupees, setSellPriceRupees] = useState('');
  const [sellDate, setSellDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hypothetical, setHypothetical] = useState<SellPlanResult | null>(null);
  const [hypotheticalError, setHypotheticalError] = useState<string | null>(null);

  const isLoading = txnsLoading || etfsLoading || chargesLoading || taxConfigLoading || !profile;

  const txnsByEtf = useMemo(() => {
    const map = new Map<number, TransactionRow[]>();
    for (const t of transactions ?? []) {
      const arr = map.get(t.etf_id) ?? [];
      arr.push(t);
      map.set(t.etf_id, arr);
    }
    return map;
  }, [transactions]);

  const etfAssetClassById = useMemo(() => new Map((etfs ?? []).map((e) => [e.id, e.asset_class])), [etfs]);
  const heldEquityEtfs = useMemo(
    () => (etfs ?? []).filter((e) => e.asset_class === 'equity' && (txnsByEtf.get(e.id)?.length ?? 0) > 0),
    [etfs, txnsByEtf]
  );

  const fyReplay = useMemo(() => {
    if (isLoading || !transactions || !etfs || !chargesConfig || !taxConfigs || !profile) return null;
    return replayFyEquitySells(
      txnsByEtf, etfAssetClassById, fyStart, fyEnd, usedElsewherePaise,
      taxConfigs.map((c) => ({
        assetClass: c.asset_class, effectiveFrom: c.effective_from, effectiveTo: c.effective_to,
        acquiredFrom: c.acquired_from, acquiredTo: c.acquired_to, stcgMode: c.stcg_mode,
        stcgRatePct: c.stcg_rate_pct ? Number(c.stcg_rate_pct) : null, ltcgMonths: c.ltcg_months,
        ltcgRatePct: Number(c.ltcg_rate_pct), ltcgExemptionPaise: BigInt(c.ltcg_exemption_paise), cessPct: Number(c.cess_pct),
      })),
      toEngineChargeConfig(chargesConfig), toEngineOverrides(overrides ?? []), Number(profile.tax_slab_pct)
    );
  }, [isLoading, transactions, etfs, chargesConfig, taxConfigs, profile, txnsByEtf, etfAssetClassById, fyStart, fyEnd, usedElsewherePaise, overrides]);

  const fySummary = fyReplay ? summarizeFyReport(fyReplay.realizedSells, fyReplay.exemptionRemainingPaise) : null;

  async function handleSaveExemptionInput() {
    try {
      await upsertFyExemptionInput({
        user_id: userId, fy, used_elsewhere_paise: usedElsewherePaise.toString(), entered_on: new Date().toISOString().slice(0, 10),
      }).unwrap();
      toast.success('Saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save.');
    }
  }

  function handleComputeHypothetical() {
    setHypotheticalError(null);
    setHypothetical(null);
    if (!selectedEtfId || !sellQty || !sellPriceRupees || !chargesConfig || !taxConfigs || !profile || !fyReplay) return;
    const etf = etfs?.find((e) => e.id === selectedEtfId);
    if (!etf) return;

    try {
      const currentLots = computeRemainingLots(
        toEngineTransactions(txnsByEtf.get(selectedEtfId) ?? []), etf.asset_class as AssetClass,
        toEngineChargeConfig(chargesConfig), toEngineOverrides(overrides ?? [])
      );
      const result = computeSellPlan({
        assetClass: etf.asset_class as AssetClass, ltcgMonthsOverride: etf.ltcg_months, sellDate, sellPricePaise: BigInt(Math.round(Number(sellPriceRupees) * 100)),
        sellQty: Number(sellQty), currentLots,
        taxConfigs: taxConfigs.map((c) => ({
          assetClass: c.asset_class, effectiveFrom: c.effective_from, effectiveTo: c.effective_to,
          acquiredFrom: c.acquired_from, acquiredTo: c.acquired_to, stcgMode: c.stcg_mode,
          stcgRatePct: c.stcg_rate_pct ? Number(c.stcg_rate_pct) : null, ltcgMonths: c.ltcg_months,
          ltcgRatePct: Number(c.ltcg_rate_pct), ltcgExemptionPaise: BigInt(c.ltcg_exemption_paise), cessPct: Number(c.cess_pct),
        })),
        brokerChargeConfigs: toEngineChargeConfig(chargesConfig), chargeOverrides: toEngineOverrides(overrides ?? []),
        slabPct: Number(profile.tax_slab_pct), exemptionRemainingPaise: fyReplay.exemptionRemainingPaise,
      });
      setHypothetical(result);
    } catch (err) {
      setHypotheticalError(err instanceof Error ? err.message : 'Could not compute this sell.');
    }
  }

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Taxes</h1>

      <Card>
        <CardHeader><CardTitle>Sell planner — what if I sell?</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-2">
              <Label>ETF</Label>
              <Select value={selectedEtfId?.toString() ?? ''} onValueChange={(v) => setSelectedEtfId(Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {heldEquityEtfs.map((e) => <SelectItem key={e.id} value={e.id.toString()}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Units</Label>
              <Input type="number" min="1" value={sellQty} onChange={(e) => setSellQty(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Price (₹)</Label>
              <Input type="number" min="0" step="0.01" value={sellPriceRupees} onChange={(e) => setSellPriceRupees(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Sell date</Label>
              <Input type="date" value={sellDate} onChange={(e) => setSellDate(e.target.value)} />
            </div>
          </div>
          <Button onClick={handleComputeHypothetical} disabled={!selectedEtfId || !sellQty || !sellPriceRupees}>Compute</Button>
          {hypotheticalError && <p className="text-sm text-destructive">{hypotheticalError}</p>}

          {hypothetical && (
            <div className="space-y-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lot</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>Held</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Taxable gain</TableHead>
                    <TableHead>Exemption used</TableHead>
                    <TableHead>Tax + cess</TableHead>
                    <TableHead>Net proceeds</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hypothetical.slices.map((s) => (
                    <TableRow key={s.lotId}>
                      <TableCell>{s.buyDate}</TableCell>
                      <TableCell>{s.qty}</TableCell>
                      <TableCell>{s.monthsHeld}mo</TableCell>
                      <TableCell>{s.classification}</TableCell>
                      <TableCell className="tabular-nums">{formatPaiseExact(s.taxableGainPaise)}</TableCell>
                      <TableCell className="tabular-nums">{formatPaiseExact(s.exemptionUsedPaise)}</TableCell>
                      <TableCell className="tabular-nums">{formatPaiseExact(s.taxWithCessPaise)}</TableCell>
                      <TableCell className="tabular-nums">{formatPaiseExact(s.netProceedsPaise)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex gap-6 text-sm font-medium">
                <span>Total tax: {formatPaiseExact(hypothetical.totalTaxWithCessPaise)}</span>
                <span>Net proceeds: {formatPaiseExact(hypothetical.totalNetProceedsPaise)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>FY {fy.replace('FY', '')} report</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="space-y-2">
              <Label>Equity LTCG exemption used elsewhere this FY (₹)</Label>
              <Input
                type="number" min="0" className="w-48"
                value={usedElsewhereRupees || (fyExemptionInput ? (Number(fyExemptionInput.used_elsewhere_paise) / 100).toString() : '')}
                onChange={(e) => setUsedElsewhereRupees(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={handleSaveExemptionInput}>Save</Button>
          </div>

          {fySummary && (
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div className="rounded-md border border-border p-3">
                <dt className="text-muted-foreground">STCG gain</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(fySummary.stcgGainPaise)}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-muted-foreground">LTCG gain</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(fySummary.ltcgGainPaise)}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-muted-foreground">Tax + cess (realized)</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(fySummary.totalTaxPaise)}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-muted-foreground">Exemption remaining</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(fySummary.exemptionRemainingPaise)}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-muted-foreground">STCL carried forward</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(fySummary.setOff.stclCarriedForwardPaise)}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-muted-foreground">LTCL carried forward</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPaise(fySummary.setOff.ltclCarriedForwardPaise)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <Disclaimer variant="both" />
    </div>
  );
}
