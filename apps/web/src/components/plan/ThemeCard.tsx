import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ScoreBar } from './ScoreBar';
import { EtfPickRow } from './EtfPickRow';
import { formatPct } from '@/lib/money';
import { themeFactorBullets } from '@/lib/factorBullets';
import type { RecommendationItemRow, EtfRow, ThemeRow } from '@/types/db';

interface Props {
  themeItem: RecommendationItemRow;
  theme: ThemeRow | undefined;
  etfItems: RecommendationItemRow[];
  etfById: Map<number, EtfRow>;
  runId: string;
  nextThemeItem: RecommendationItemRow | undefined;
}

export function ThemeCard({ themeItem, theme, etfItems, etfById, runId, nextThemeItem }: Props) {
  const [expanded, setExpanded] = useState(true);
  const factorJson = themeItem.factor_json as Record<string, unknown> & {
    momentumPercentile?: number; trendPercentile?: number; breadthPercentile?: number;
    diversify?: { score?: number };
  };

  return (
    <div className="rounded-lg border border-border">
      <button
        className="w-full flex items-center justify-between gap-4 p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">#{themeItem.rank} {theme?.name ?? themeItem.theme_key}</span>
            <span className="text-xs text-muted-foreground tabular-nums">target {formatPct(themeItem.weight_target ? Number(themeItem.weight_target) : null)}</span>
          </div>
          {themeItem.narrative ? (
            <p className="text-sm text-muted-foreground mt-1">{themeItem.narrative}</p>
          ) : (
            <ul className="text-sm text-muted-foreground mt-1 list-disc list-inside">
              {themeFactorBullets(factorJson).map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
          {nextThemeItem && (
            <p className="text-xs text-muted-foreground mt-1">Ranked above #{nextThemeItem.rank} {nextThemeItem.theme_key}.</p>
          )}
        </div>
        {expanded ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <ScoreBar label="Momentum" value={factorJson.momentumPercentile} />
            <ScoreBar label="Trend" value={factorJson.trendPercentile} />
            <ScoreBar label="Breadth" value={factorJson.breadthPercentile} />
            <ScoreBar label="Diversifies" value={factorJson.diversify?.score} />
          </div>
          <div className="space-y-3">
            {etfItems.map((item, i) => (
              <EtfPickRow key={item.id} item={item} etf={etfById.get(item.etf_id!)} runId={runId} nextItem={etfItems[i + 1]} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
