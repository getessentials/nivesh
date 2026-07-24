/**
 * Sonnet + web search theme-candidate research (docs/03 §2.1, docs/01 §3.2 stage 1). The model
 * researches freely with `web_search`, then must call the client-declared `propose_themes` tool
 * exactly once with its final structured candidate list — that tool_use IS the structured output;
 * we never execute it or send a tool_result back, we just read its input and end the turn there.
 * Retry-once-then-fallback (docs/03 §2.5) is orchestrated here; the deterministic fallback SET
 * itself is built by the caller (it needs the seeded `themes` table, which this module doesn't
 * touch).
 */
import Anthropic from '@anthropic-ai/sdk';
import { RESEARCH_MODEL, usageCostUsd } from './llm.ts';
import { ThemeCandidatesSchema, filterToSeededThemeKeys, type ThemeCandidate } from './llm-containment.ts';

const PROPOSE_THEMES_TOOL: Anthropic.Tool = {
  name: 'propose_themes',
  description:
    'Submit your final list of candidate investable themes with macro rationale. Call this ' +
    'exactly once, only after you have finished researching, and do not call any tool after it.',
  input_schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            theme_key: { type: 'string', description: 'must exactly match one of the seeded theme keys given in the system prompt' },
            thesis: { type: 'string', description: 'one-paragraph macro/policy rationale' },
            policy_tailwind_score: { type: 'number', minimum: 0, maximum: 5 },
            sources: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'https:// source URLs' },
          },
          required: ['theme_key', 'thesis', 'policy_tailwind_score', 'sources'],
        },
      },
    },
    required: ['candidates'],
  },
};

function buildSystemPrompt(seededThemeKeys: readonly string[]): string {
  return [
    'You are a macro research assistant for an Indian ETF investment advisor.',
    'Research current policy and macro tailwinds for Indian equity and commodity investment ' +
      'themes using web search, focused on developments from the last 1-3 months.',
    `Only propose themes from this exact seeded set - do not invent a theme_key that is not in ` +
      `this list: ${seededThemeKeys.join(', ')}.`,
    'When you have finished researching, call propose_themes exactly once with up to 10 ' +
      'candidates. Each needs a one-paragraph thesis, a policy_tailwind_score from 0 to 5, and ' +
      '1-3 https:// source URLs you found via web search. Do not call propose_themes more than ' +
      'once and do not keep researching after calling it.',
  ].join('\n');
}

const MAX_ROUNDS_PER_ATTEMPT = 6; // bounds pause_turn/nudge loops within one attempt

interface AttemptResult {
  /** null on any failure mode (refusal, max_tokens, exhausted rounds) — costUsd is still
   *  meaningful in that case, since tokens billed before a failure are still billed. */
  rawCandidates: unknown | null;
  costUsd: number;
}

async function runOneAttempt(client: Anthropic, seededThemeKeys: readonly string[]): Promise<AttemptResult> {
  let costUsd = 0;
  let messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: "Research this month's policy/macro tailwinds for the seeded investable themes and propose candidates.",
    },
  ];
  const system = buildSystemPrompt(seededThemeKeys);
  const tools: Anthropic.ToolUnion[] = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
    PROPOSE_THEMES_TOOL,
  ];

  for (let round = 0; round < MAX_ROUNDS_PER_ATTEMPT; round++) {
    const response = await client.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 4000,
      system,
      messages,
      tools,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
    costUsd += usageCostUsd(RESEARCH_MODEL, response.usage);

    if (response.stop_reason === 'refusal') return { rawCandidates: null, costUsd };

    const proposeCall = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_themes'
    );
    if (proposeCall) {
      return { rawCandidates: (proposeCall.input as { candidates: unknown }).candidates, costUsd };
    }

    if (response.stop_reason === 'pause_turn') {
      // Server-tool (web_search) internal iteration cap hit — resend to let it continue
      // (docs: re-send the same conversation; the API resumes automatically, no synthetic
      // "Continue" message).
      messages = [...messages, { role: 'assistant', content: response.content }];
      continue;
    }
    if (response.stop_reason === 'end_turn') {
      // Finished thinking without calling propose_themes — nudge once, still within this attempt.
      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: 'You did not call propose_themes. Call it now with your final candidate list.' },
      ];
      continue;
    }
    return { rawCandidates: null, costUsd }; // max_tokens, or an unexpected tool_use — failed attempt
  }
  return { rawCandidates: null, costUsd }; // exhausted rounds without a propose_themes call
}

export interface ThemeResearchResult {
  candidates: ThemeCandidate[];
  costUsd: number;
  ok: boolean;
}

/**
 * Retry-once-then-fallback (docs/03 §2.5): runs up to two attempts, Zod-validates and filters the
 * result of each to the seeded theme keys. `ok: false` means BOTH attempts failed (refusal,
 * malformed output, or empty candidate list after filtering) — the caller must fall back to the
 * deterministic default set. `costUsd` accumulates across every attempt made, successful or not,
 * so the spend cap accounting is never short-changed by a failed call.
 */
export async function researchThemeCandidates(
  client: Anthropic,
  seededThemeKeys: readonly string[]
): Promise<ThemeResearchResult> {
  let totalCostUsd = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runOneAttempt(client, seededThemeKeys);
    totalCostUsd += result.costUsd;
    if (result.rawCandidates === null) continue;

    const parsed = ThemeCandidatesSchema.safeParse(result.rawCandidates);
    if (!parsed.success) continue;

    const filtered = filterToSeededThemeKeys(parsed.data, new Set(seededThemeKeys));
    if (filtered.length > 0) return { candidates: filtered, costUsd: totalCostUsd, ok: true };
  }

  return { candidates: [], costUsd: totalCostUsd, ok: false };
}
