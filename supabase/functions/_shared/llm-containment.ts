/**
 * LLM output containment (docs/09 §8, docs/03 §2.1). Everything the LLM is allowed to influence
 * passes through here: theme-candidate shape validation (Zod) plus theme_key set-membership
 * against the seeded `themes` table, citation URL well-formedness, and the narrative
 * numeric-grounding check that gates whether a Haiku narrative may be shown at all.
 */
import { z } from 'zod';

export const ThemeCandidateSchema = z.object({
  theme_key: z.string().min(1).max(64),
  thesis: z.string().min(1).max(2000),
  policy_tailwind_score: z.number().min(0).max(5),
  sources: z
    .array(
      z
        .string()
        .url()
        .refine((u) => u.startsWith('https://'), { message: 'citation URL must use https:// (docs/09 §8)' })
    )
    .max(10),
});
export type ThemeCandidate = z.infer<typeof ThemeCandidateSchema>;

/** docs/03 §2.1: "Sonnet + web search returns <=10 candidates". */
export const ThemeCandidatesSchema = z.array(ThemeCandidateSchema).max(10);

/**
 * theme_key containment (docs/03 §2.1: "LLM cannot invent themes", docs/09 §8 SEC-1): Zod
 * validates SHAPE, this filters by CONTENT against the seeded `themes` table. Candidates naming
 * an unseeded key are dropped, not errored — one bad candidate must never fail the whole research
 * pass (the fallback set exists for total failure, docs/03 §2.5; a partial hallucination is just
 * one fewer candidate).
 */
export function filterToSeededThemeKeys(
  candidates: readonly ThemeCandidate[],
  seededThemeKeys: ReadonlySet<string>
): ThemeCandidate[] {
  return candidates.filter((c) => seededThemeKeys.has(c.theme_key));
}

// ---- Narrative numeric grounding (docs/09 §8) ----

/** Matches signed decimals, optionally with a trailing '%' and/or thousands separators
 *  (e.g. "-0.38%", "1,25,000", "12.5"). Doesn't match bare rank markers like "#2" — the '#'
 *  isn't part of the numeric character class, so only the digits after it are captured, which
 *  the rank-reference exemption below then lets through (see `isPlausibleRankReference`). The
 *  trailing negative lookahead excludes digits immediately followed by a letter (e.g. the "1" in
 *  "TD 1y" — a unit/factor-name label, not a numeric data claim) so labels don't get flagged as
 *  ungrounded numbers. */
const NUMERIC_TOKEN_RE = /-?\d[\d,]*(?:\.\d+)?%?(?![a-zA-Z])/g;

function parseNumericToken(token: string): number {
  const isPercent = token.endsWith('%');
  const cleaned = (isPercent ? token.slice(0, -1) : token).replace(/,/g, '');
  return Number(cleaned);
}

/**
 * Small bare integers immediately preceded by '#' (optionally with one space, "#2" or "# 2") are
 * exempted as rank references ("why above #2") rather than data claims — docs/01 §5's required
 * comparison line always includes one. The exemption is deliberately narrow: it checks the
 * character(s) immediately before the token in the ORIGINAL text, not just the token's own shape
 * (no decimal point, no '%', small magnitude) — a purely shape-based check would let any small
 * fabricated integer anywhere in the narrative slip through ungrounded (e.g. "cut costs by 3
 * last quarter"), which is exactly the kind of hallucinated number this check exists to catch.
 */
const RANK_REFERENCE_MAX = 20;
const RANK_PREFIX_RE = /#\s?$/;

function isPlausibleRankReference(token: string, value: number, textBeforeToken: string): boolean {
  return !token.includes('.') && !token.endsWith('%') && Number.isInteger(value) &&
    Math.abs(value) <= RANK_REFERENCE_MAX && RANK_PREFIX_RE.test(textBeforeToken);
}

/** Recursively collects every numeric leaf value out of an arbitrary JSON value (the factor_json
 *  a narrative was generated from). */
export function extractFactorNumbers(factorJson: unknown): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(factorJson);
  return out;
}

/** Two numbers "match" if they agree once both are rounded to whichever of 0/1/2 decimal places
 *  the NARRATIVE number appears to have been written at — a narrative writing "-0.38%" should
 *  match a factor_json value of -0.3812345, and "20%" should match 20.0001. */
function roundedMatch(narrativeValue: number, factorValue: number, narrativeToken: string): boolean {
  const decimals = narrativeToken.includes('.') ? (narrativeToken.split('.')[1]?.replace('%', '').length ?? 0) : 0;
  const scale = 10 ** decimals;
  return Math.round(narrativeValue * scale) === Math.round(factorValue * scale);
}

export interface GroundingResult {
  grounded: boolean;
  ungroundedTokens: string[];
}

/**
 * Post-generation numeric check (docs/09 §8): every numeric token in `narrative` must correspond
 * to a value present in `factorJson` (the ONLY data the narrative model was given). Small bare
 * integers are exempted as rank references (see above). Returns every ungrounded token for
 * diagnostics even though the caller only needs the boolean to decide regenerate-vs-fallback.
 */
export function checkNarrativeGrounding(narrative: string, factorJson: unknown): GroundingResult {
  const factorNumbers = extractFactorNumbers(factorJson);
  const ungrounded: string[] = [];

  for (const match of narrative.matchAll(NUMERIC_TOKEN_RE)) {
    const token = match[0];
    const value = parseNumericToken(token);
    if (!Number.isFinite(value)) continue;
    const textBeforeToken = narrative.slice(0, match.index);
    if (isPlausibleRankReference(token, value, textBeforeToken)) continue;
    const matches = factorNumbers.some((f) => roundedMatch(value, f, token));
    if (!matches) ungrounded.push(token);
  }
  return { grounded: ungrounded.length === 0, ungroundedTokens: ungrounded };
}
