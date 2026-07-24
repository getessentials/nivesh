/** A single labeled 0-1 score/percentile bar (docs/01 §4: "score breakdown bars"). */
export function ScoreBar({ label, value }: { label: string; value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground truncate">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-chart-1" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{pct}</span>
    </div>
  );
}
