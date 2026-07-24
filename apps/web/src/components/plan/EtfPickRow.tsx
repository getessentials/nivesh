import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScoreBar } from './ScoreBar';
import { MarkBoughtDialog } from './MarkBoughtDialog';
import { formatPaise, formatPct } from '@/lib/money';
import { etfFactorBullets, factorTags } from '@/lib/factorBullets';
import type { RecommendationItemRow, EtfRow } from '@/types/db';

interface Props {
  item: RecommendationItemRow;
  etf: EtfRow | undefined;
  runId: string;
  nextItem: RecommendationItemRow | undefined;
}

export function EtfPickRow({ item, etf, runId, nextItem }: Props) {
  const [markBoughtOpen, setMarkBoughtOpen] = useState(false);
  const factorJson = item.factor_json as Record<string, unknown> & {
    trackingQualityPercentile?: number; liquidityPercentile?: number; costPercentile?: number;
    scalePercentile?: number; peerReturnPercentile?: number; momentumPercentile?: number;
  };
  const units = item.units ?? 0;
  const allocPaise = item.alloc_paise ? BigInt(item.alloc_paise) : 0n;
  const estimatedPriceRupees = units > 0 ? Number(allocPaise) / 100 / units : 0;
  const tags = factorTags(factorJson);

  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">#{item.rank} {etf?.name ?? `ETF ${item.etf_id}`}</span>
            {tags.includes('young_fund') && <Badge variant="outline">young fund</Badge>}
            {tags.includes('small_cohort') && <Badge variant="outline">small cohort</Badge>}
            {tags.includes('full_universe_fallback') && <Badge variant="outline">wide cohort</Badge>}
          </div>
          {item.narrative ? (
            <p className="text-sm text-muted-foreground mt-1">{item.narrative}</p>
          ) : (
            <ul className="text-sm text-muted-foreground mt-1 list-disc list-inside">
              {etfFactorBullets(factorJson).map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
          {nextItem && !item.narrative && (
            <p className="text-xs text-muted-foreground mt-1">Ranked above #{nextItem.rank} on score.</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-medium tabular-nums">{formatPaise(allocPaise)}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{units} units · target {formatPct(item.weight_target ? Number(item.weight_target) : null)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <ScoreBar label="Tracking quality" value={factorJson.trackingQualityPercentile} />
        <ScoreBar label="Liquidity" value={factorJson.liquidityPercentile} />
        <ScoreBar label="Cost" value={factorJson.costPercentile} />
        <ScoreBar label="Scale" value={factorJson.scalePercentile} />
        <ScoreBar label="Peer return" value={factorJson.peerReturnPercentile} />
        <ScoreBar label="Momentum" value={factorJson.momentumPercentile} />
      </div>

      {units > 0 && (
        <Button size="sm" variant="secondary" onClick={() => setMarkBoughtOpen(true)}>
          Mark bought
        </Button>
      )}

      <MarkBoughtDialog
        open={markBoughtOpen}
        onOpenChange={setMarkBoughtOpen}
        runId={runId}
        etfId={item.etf_id!}
        etfName={etf?.name ?? `ETF ${item.etf_id}`}
        defaultUnits={units}
        estimatedPriceRupees={estimatedPriceRupees}
      />
    </div>
  );
}
