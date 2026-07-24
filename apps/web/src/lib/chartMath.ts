/** Rebases a {d, value} series to 100 at (or the first observation on/after) `sinceDate` — the
 *  normalization docs/01 §3.3 requires for the holding-vs-benchmark-vs-rivals chart. */
export interface SeriesPoint { d: string; value: number }

export function rebaseTo100(series: readonly SeriesPoint[], sinceDate: string): SeriesPoint[] {
  const filtered = series.filter((p) => p.d >= sinceDate).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (filtered.length === 0) return [];
  const base = filtered[0]!.value;
  if (base === 0) return [];
  return filtered.map((p) => ({ d: p.d, value: (p.value / base) * 100 }));
}

/** Merges several rebased series into one array of {d, seriesA, seriesB, ...} rows for Recharts,
 *  keyed by date union (missing values simply aren't plotted for that date on that line). */
export function mergeSeriesForChart(
  seriesByLabel: Record<string, SeriesPoint[]>
): Array<{ d: string } & Record<string, number | string>> {
  const dates = new Set<string>();
  for (const s of Object.values(seriesByLabel)) for (const p of s) dates.add(p.d);
  const sortedDates = [...dates].sort();
  return sortedDates.map((d) => {
    const row: { d: string } & Record<string, number | string> = { d };
    for (const [label, series] of Object.entries(seriesByLabel)) {
      const point = series.find((p) => p.d === d);
      if (point) row[label] = point.value;
    }
    return row;
  });
}
