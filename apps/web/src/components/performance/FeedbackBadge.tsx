import { Badge } from '@/components/ui/badge';
import type { FeedbackScoreRow } from '@/types/db';

/** OUTPERFORM/INLINE/LAG badge with the numbers that produced it (docs/03 §5 — always shown with
 *  its inputs, never a bare label). */
export function FeedbackBadge({ score }: { score: FeedbackScoreRow | undefined }) {
  if (!score) return null;
  const detail = score.detail as { excessPct?: number; peerGapPct?: number; status?: 'OUTPERFORM' | 'LAG' | 'INLINE' };
  if (!detail.status) return null;

  const variant = detail.status === 'OUTPERFORM' ? 'default' : detail.status === 'LAG' ? 'destructive' : 'secondary';
  return (
    <div className="flex items-center gap-2">
      <Badge variant={variant}>{detail.status}</Badge>
      {typeof detail.excessPct === 'number' && (
        <span className="text-xs text-muted-foreground tabular-nums">
          excess {detail.excessPct >= 0 ? '+' : ''}{detail.excessPct.toFixed(2)}%
          {typeof detail.peerGapPct === 'number' && `, peer gap ${detail.peerGapPct >= 0 ? '+' : ''}${detail.peerGapPct.toFixed(2)}%`}
        </span>
      )}
    </div>
  );
}
