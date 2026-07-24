/** Indian FY: 1 April - 31 March, formatted "FY2026-27" (docs/04 §2.1, docs/05 fy_exemption_inputs). */
export function fyForDate(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const year = d.getUTCFullYear();
  const isAfterApril = d.getUTCMonth() >= 3; // 0-indexed: 3 = April
  const startYear = isAfterApril ? year : year - 1;
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function currentFy(): string {
  return fyForDate(new Date().toISOString().slice(0, 10));
}

/** [start, end] ISO dates (inclusive) for a "FY2026-27"-style string. */
export function fyDateRange(fy: string): { start: string; end: string } {
  const startYear = Number(fy.slice(2, 6));
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}
