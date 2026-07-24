import { assert, assertEquals, assertFalse } from '@std/assert';
import {
  ThemeCandidateSchema, ThemeCandidatesSchema, filterToSeededThemeKeys,
  extractFactorNumbers, checkNarrativeGrounding,
} from './llm-containment.ts';

Deno.test('ThemeCandidateSchema accepts a well-formed candidate', () => {
  const result = ThemeCandidateSchema.safeParse({
    theme_key: 'defence',
    thesis: 'Rising defence capex.',
    policy_tailwind_score: 4,
    sources: ['https://example.com/article'],
  });
  assert(result.success);
});

Deno.test('ThemeCandidateSchema rejects a non-https citation URL', () => {
  const result = ThemeCandidateSchema.safeParse({
    theme_key: 'defence',
    thesis: 'x',
    policy_tailwind_score: 3,
    sources: ['http://example.com/article'],
  });
  assertFalse(result.success);
});

Deno.test('ThemeCandidateSchema rejects a malformed URL', () => {
  const result = ThemeCandidateSchema.safeParse({
    theme_key: 'defence',
    thesis: 'x',
    policy_tailwind_score: 3,
    sources: ['not-a-url'],
  });
  assertFalse(result.success);
});

Deno.test('ThemeCandidateSchema rejects an out-of-range policy score', () => {
  const result = ThemeCandidateSchema.safeParse({
    theme_key: 'defence', thesis: 'x', policy_tailwind_score: 6, sources: [],
  });
  assertFalse(result.success);
});

Deno.test('ThemeCandidatesSchema caps at 10 candidates', () => {
  const one = { theme_key: 'defence', thesis: 'x', policy_tailwind_score: 3, sources: [] };
  const result = ThemeCandidatesSchema.safeParse(new Array(11).fill(one));
  assertFalse(result.success);
});

Deno.test('filterToSeededThemeKeys drops candidates naming an unseeded theme (LLM cannot invent themes)', () => {
  const candidates = [
    { theme_key: 'defence', thesis: 'x', policy_tailwind_score: 3, sources: [] },
    { theme_key: 'made_up_theme', thesis: 'y', policy_tailwind_score: 2, sources: [] },
  ];
  const filtered = filterToSeededThemeKeys(candidates, new Set(['defence', 'manufacturing']));
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0]!.theme_key, 'defence');
});

Deno.test('extractFactorNumbers walks nested objects and arrays', () => {
  const factorJson = { td1y: -0.38, peers: { median: -0.61 }, rankHistory: [1, 2, 3], label: 'x' };
  const nums = extractFactorNumbers(factorJson);
  assertEquals(nums.sort((a, b) => a - b), [-0.61, -0.38, 1, 2, 3]);
});

Deno.test('checkNarrativeGrounding passes when every numeric claim is in factor_json', () => {
  const factorJson = { td1y: -0.38, peerTd1y: -0.61 };
  const narrative = 'TD 1y -0.38% vs peer -0.61%. This is why #1 beats #2.';
  const result = checkNarrativeGrounding(narrative, factorJson);
  assert(result.grounded, `expected grounded, ungrounded=${JSON.stringify(result.ungroundedTokens)}`);
});

Deno.test('checkNarrativeGrounding flags a fabricated number not present in factor_json', () => {
  const factorJson = { td1y: -0.38 };
  const narrative = 'TD 1y is -0.38%, AUM is 500 cr.'; // 500 not in factor_json
  const result = checkNarrativeGrounding(narrative, factorJson);
  assertFalse(result.grounded);
  assertEquals(result.ungroundedTokens, ['500']);
});

Deno.test('checkNarrativeGrounding tolerates rounding relative to the narrative\'s own precision', () => {
  const factorJson = { td1y: -0.3812345 };
  const narrative = 'TD 1y is -0.38%.';
  assert(checkNarrativeGrounding(narrative, factorJson).grounded);
});

Deno.test('checkNarrativeGrounding does not exempt a large bare integer as a rank reference', () => {
  const factorJson = { aumCr: 120 };
  const narrative = 'AUM is 999 cr.'; // far outside the rank-reference range and not in factor_json
  const result = checkNarrativeGrounding(narrative, factorJson);
  assertFalse(result.grounded);
});

Deno.test('checkNarrativeGrounding rejects a small fabricated integer NOT adjacent to a rank marker (regression: the exemption used to be shape-only)', () => {
  const factorJson = { td1y: -0.38 };
  const narrative = 'TD 1y is -0.38%; this ETF cut costs by 3 last quarter.'; // "3" is a fabrication
  const result = checkNarrativeGrounding(narrative, factorJson);
  assertFalse(result.grounded);
  assertEquals(result.ungroundedTokens, ['3']);
});

Deno.test('checkNarrativeGrounding still exempts a rank reference preceded by "# "', () => {
  const factorJson = { td1y: -0.38 };
  const narrative = 'TD 1y is -0.38%; why above # 2.';
  assert(checkNarrativeGrounding(narrative, factorJson).grounded);
});

Deno.test('checkNarrativeGrounding does not treat a unit-suffixed number (e.g. "1y") as a numeric claim', () => {
  const factorJson = { momentumReturnPct: 5.2 };
  const narrative = 'Momentum over 6m is 5.2%, well ahead of peers.';
  const result = checkNarrativeGrounding(narrative, factorJson);
  assert(result.grounded, `expected grounded, ungrounded=${JSON.stringify(result.ungroundedTokens)}`);
});
