import type { RiskAppetite } from '@niveshetf/engine';

/**
 * 5-question risk quiz -> one of conservative/moderate/aggressive (docs/01 §3.1: "risk appetite
 * ... 5-question quiz maps to one of the three"). The docs don't pin exact questions/scoring, so
 * this is this build's own defensible design: each answer scores 1 (most conservative) to 3 (most
 * aggressive); the 5-15 point sum splits roughly into thirds.
 */
export interface QuizQuestion {
  id: string;
  prompt: string;
  options: Array<{ label: string; score: 1 | 2 | 3 }>;
}

export const RISK_QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'horizon',
    prompt: 'When do you expect to need this money?',
    options: [
      { label: 'Within 3 years', score: 1 },
      { label: '3–7 years', score: 2 },
      { label: '7+ years', score: 3 },
    ],
  },
  {
    id: 'drawdown_reaction',
    prompt: 'Your portfolio drops 20% in a month. What do you do?',
    options: [
      { label: 'Sell some to limit further loss', score: 1 },
      { label: 'Hold and wait it out', score: 2 },
      { label: 'See it as a buying opportunity', score: 3 },
    ],
  },
  {
    id: 'experience',
    prompt: 'How much experience do you have investing in equities?',
    options: [
      { label: 'None or very little', score: 1 },
      { label: 'Some, a few years', score: 2 },
      { label: 'Extensive, 5+ years', score: 3 },
    ],
  },
  {
    id: 'income_stability',
    prompt: 'How stable is your income?',
    options: [
      { label: 'Variable / uncertain', score: 1 },
      { label: 'Stable, single source', score: 2 },
      { label: 'Stable, multiple sources', score: 3 },
    ],
  },
  {
    id: 'goal',
    prompt: 'What is the primary goal for this money?',
    options: [
      { label: 'Capital preservation', score: 1 },
      { label: 'Balanced growth and safety', score: 2 },
      { label: 'Maximum long-term growth', score: 3 },
    ],
  },
];

/** Sum range is 5-15; split into three roughly-equal bands. */
export function scoreToRiskAppetite(totalScore: number): RiskAppetite {
  if (totalScore <= 8) return 'conservative';
  if (totalScore <= 11) return 'moderate';
  return 'aggressive';
}
