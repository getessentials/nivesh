/**
 * docs/01 §4: every screen showing recommendations, badges, or sell suggestions carries this
 * footer verbatim. Screen 6 (Taxes) and the FY report additionally carry the tax variant.
 * Exported artifacts (plan CSV, FY report) embed the same text as their first line (docs/09 §7) —
 * `disclaimerLine()` below is the single source of truth for that text so the two can never drift.
 */
export function investmentDisclaimerText(): string {
  return 'Educational analysis, not investment advice. Not SEBI-registered.';
}

export function taxDisclaimerText(): string {
  return 'Computed estimates, not tax advice; verify with a tax professional.';
}

export function Disclaimer({ variant = 'investment' }: { variant?: 'investment' | 'tax' | 'both' }) {
  return (
    <p className="text-xs text-muted-foreground border-t border-border pt-3 mt-6">
      {(variant === 'investment' || variant === 'both') && investmentDisclaimerText()}
      {variant === 'both' && ' '}
      {(variant === 'tax' || variant === 'both') && taxDisclaimerText()}
    </p>
  );
}
