import { describe, expect, it } from 'vitest';
import { classifySliceLoss, computeSetOffSuggestion } from '../src/tax.ts';

describe('classifySliceLoss (docs/04 §2.5)', () => {
  it('a gain classifies as neither STCL nor LTCL', () => {
    expect(classifySliceLoss(100_000n, 'STCG')).toEqual({ stclPaise: 0n, ltclPaise: 0n });
    expect(classifySliceLoss(0n, 'LTCG')).toEqual({ stclPaise: 0n, ltclPaise: 0n });
  });
  it('an STCG-classified loss is STCL', () => {
    expect(classifySliceLoss(-50_000n, 'STCG')).toEqual({ stclPaise: 50_000n, ltclPaise: 0n });
  });
  it('an LTCG-classified loss is LTCL', () => {
    expect(classifySliceLoss(-75_000n, 'LTCG')).toEqual({ stclPaise: 0n, ltclPaise: 75_000n });
  });
});

describe('computeSetOffSuggestion (docs/04 §2.5)', () => {
  it('STCL offsets STCG first', () => {
    const r = computeSetOffSuggestion(30_000n, 0n, 100_000n, 0n);
    expect(r.stclAppliedToStcgPaise).toBe(30_000n);
    expect(r.stclCarriedForwardPaise).toBe(0n);
  });

  it('STCL spills over to LTCG once STCG is fully offset (docs/04 §2.5: STCL offsets STCG+LTCG)', () => {
    const r = computeSetOffSuggestion(150_000n, 0n, 100_000n, 200_000n);
    expect(r.stclAppliedToStcgPaise).toBe(100_000n); // fully offsets the smaller STCG gain
    expect(r.stclAppliedToLtcgPaise).toBe(50_000n); // remaining 50k spills into LTCG
    expect(r.stclCarriedForwardPaise).toBe(0n);
  });

  it('LTCL offsets LTCG only, never STCG', () => {
    const r = computeSetOffSuggestion(0n, 40_000n, 100_000n, 20_000n);
    expect(r.ltclAppliedToLtcgPaise).toBe(20_000n); // capped by available LTCG gain
    expect(r.ltclCarriedForwardPaise).toBe(20_000n); // the rest carries forward, does NOT touch STCG
  });

  it('STCL is applied to LTCG before LTCL, reducing what LTCL can absorb', () => {
    const r = computeSetOffSuggestion(50_000n, 50_000n, 0n, 60_000n);
    expect(r.stclAppliedToLtcgPaise).toBe(50_000n); // STCL takes the first 50k of LTCG
    expect(r.ltclAppliedToLtcgPaise).toBe(10_000n); // LTCL only has 10k of LTCG left to offset
    expect(r.ltclCarriedForwardPaise).toBe(40_000n);
  });

  it('losses exceeding all available gains fully carry forward', () => {
    const r = computeSetOffSuggestion(500_000n, 500_000n, 0n, 0n);
    expect(r.stclCarriedForwardPaise).toBe(500_000n);
    expect(r.ltclCarriedForwardPaise).toBe(500_000n);
  });

  it('no losses, no gains -> everything zero', () => {
    const r = computeSetOffSuggestion(0n, 0n, 0n, 0n);
    expect(r).toEqual({
      stclAppliedToStcgPaise: 0n, stclAppliedToLtcgPaise: 0n, ltclAppliedToLtcgPaise: 0n,
      stclCarriedForwardPaise: 0n, ltclCarriedForwardPaise: 0n,
    });
  });
});
