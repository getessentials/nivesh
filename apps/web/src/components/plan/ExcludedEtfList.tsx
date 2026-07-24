import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { RunEtfGateResultRow, EtfRow } from '@/types/db';

const GATE_REASON_LABELS: Record<string, string> = {
  missing_aum: 'AUM data missing',
  aum_below_threshold: 'AUM below threshold',
  missing_listing_date: 'Listing date missing',
  listed_under_12_months: 'Listed under 12 months',
  missing_adtv: 'Liquidity (ADTV) data missing',
  adtv_below_threshold: 'Liquidity below threshold',
  missing_tracking_error: 'Tracking error data missing',
  tracking_error_exceeds_sebi_cap: 'Tracking error exceeds SEBI cap',
  tracking_error_exceeds_peer_relative_cap: 'Tracking error too high vs peers',
  missing_ter: 'Expense ratio data missing',
  ter_exceeds_threshold: 'Expense ratio too high',
  missing_premium_discount: 'Premium/discount data missing',
  avg_premium_discount_exceeds_threshold: '30-day premium/discount too wide',
  plan_day_premium_exceeds_threshold: "Today's premium/discount too wide",
  stale_metrics: 'Metrics data is stale',
};

export function ExcludedEtfList({ gateResults, etfById }: { gateResults: RunEtfGateResultRow[]; etfById: Map<number, EtfRow> }) {
  const [expanded, setExpanded] = useState(false);
  const excluded = gateResults.filter((r) => !r.eligible);
  if (excluded.length === 0) return null;

  return (
    <div className="rounded-lg border border-border">
      <button className="w-full flex items-center justify-between p-4 text-left" onClick={() => setExpanded((v) => !v)}>
        <span className="text-sm font-medium">Excluded ETFs ({excluded.length})</span>
        {expanded ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {excluded.map((r) => (
            <div key={`${r.etf_id}-${r.theme_key}`} className="p-3 text-sm flex items-center justify-between gap-4">
              <span>{etfById.get(r.etf_id)?.name ?? `ETF ${r.etf_id}`} <span className="text-muted-foreground">({r.theme_key})</span></span>
              <span className="text-xs text-muted-foreground text-right">
                {r.failure_reasons.map((reason) => GATE_REASON_LABELS[reason] ?? reason).join(', ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
