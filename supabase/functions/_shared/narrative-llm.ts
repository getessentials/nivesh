/**
 * Haiku narrative generation (docs/01 §3.2 stage 6, docs/01 §5 format, docs/09 §8 containment).
 * The narrative model receives ONLY each item's factor_json (plus rank/score/theme context) —
 * never holdings, prices, or anything it could use to invent a number. One batched call covers
 * every recommendation_items row in the run (cost control, docs/06); a second batched call
 * regenerates ONLY the items that fail the post-generation numeric-grounding check
 * (docs/09 §8: regenerate once, then fall back to numbers-only for whatever still fails).
 */
import Anthropic from '@anthropic-ai/sdk';
import { NARRATIVE_MODEL, usageCostUsd } from './llm.ts';
import { checkNarrativeGrounding } from './llm-containment.ts';

export interface NarrativeItemInput {
  id: string;
  level: 'theme' | 'etf';
  themeKey: string;
  etfId: number | null;
  rank: number;
  score: number;
  factorJson: unknown;
  /** the next-lower-ranked item's factor_json in the same group, if any — lets the model write
   *  the required "why above #k+1" line without inventing anything (docs/01 §5). */
  nextFactorJson: unknown | null;
}

const NARRATIVE_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    properties: {
      narratives: {
        type: 'array',
        items: {
          type: 'object',
          properties: { item_id: { type: 'string' }, text: { type: 'string' } },
          required: ['item_id', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['narratives'],
    additionalProperties: false,
  },
};

function buildPrompt(items: readonly NarrativeItemInput[]): string {
  const lines = [
    'For each item below, write a short plain-text narrative (docs/01 PRD §5 format):',
    '- One-line thesis.',
    '- Up to 3 factor bullets that cite the ACTUAL NUMBERS from that item\'s data (no invented figures).',
    '- One line: "why above #<next rank>" using ONLY the comparison data given for the next-ranked item.',
    'Plain text only — no markdown, no headers, no bullet characters, just short lines separated by newlines.',
    'Use ONLY the numbers given below for each item. Do not use outside knowledge or invent any figure.',
    '',
  ];
  for (const item of items) {
    lines.push(`item_id: ${item.id}`);
    lines.push(`level: ${item.level}, theme: ${item.themeKey}${item.etfId !== null ? `, etf_id: ${item.etfId}` : ''}, rank: ${item.rank}, score: ${item.score}`);
    lines.push(`data: ${JSON.stringify(item.factorJson)}`);
    if (item.nextFactorJson) lines.push(`next-ranked item's data (for the comparison line): ${JSON.stringify(item.nextFactorJson)}`);
    lines.push('');
  }
  return lines.join('\n');
}

interface GenerateResult {
  narrativesByItemId: Map<string, string>;
  costUsd: number;
}

async function generateOnce(client: Anthropic, items: readonly NarrativeItemInput[]): Promise<GenerateResult> {
  if (items.length === 0) return { narrativesByItemId: new Map(), costUsd: 0 };

  const response = await client.messages.create({
    model: NARRATIVE_MODEL,
    max_tokens: 4000,
    system:
      'You phrase investment-ranking explanations from data you are given. You never decide rankings, ' +
      'scores, allocations, or numbers — you only phrase the ones handed to you. Never state a number ' +
      'that does not appear in the data given for that item.',
    messages: [{ role: 'user', content: buildPrompt(items) }],
    output_config: { format: NARRATIVE_FORMAT },
  });

  const costUsd = usageCostUsd(NARRATIVE_MODEL, response.usage);
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) return { narrativesByItemId: new Map(), costUsd };

  let parsed: { narratives?: Array<{ item_id: string; text: string }> };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { narrativesByItemId: new Map(), costUsd };
  }

  const map = new Map<string, string>();
  for (const n of parsed.narratives ?? []) map.set(n.item_id, n.text);
  return { narrativesByItemId: map, costUsd };
}

export interface NarrativeGenerationResult {
  /** item id -> final narrative text, ONLY for items that passed grounding (regenerated once if
   *  needed). Items not present here fall back to numbers-only display (docs/09 §8). */
  narrativesByItemId: Map<string, string>;
  costUsd: number;
}

export async function generateNarratives(client: Anthropic, items: readonly NarrativeItemInput[]): Promise<NarrativeGenerationResult> {
  const byId = new Map(items.map((i) => [i.id, i]));
  let totalCost = 0;

  const first = await generateOnce(client, items);
  totalCost += first.costUsd;

  const grounded = new Map<string, string>();
  const needsRegeneration: NarrativeItemInput[] = [];
  for (const item of items) {
    const text = first.narrativesByItemId.get(item.id);
    if (!text) { needsRegeneration.push(item); continue; }
    if (checkNarrativeGrounding(text, item.factorJson).grounded) grounded.set(item.id, text);
    else needsRegeneration.push(item);
  }

  if (needsRegeneration.length > 0) {
    const second = await generateOnce(client, needsRegeneration);
    totalCost += second.costUsd;
    for (const item of needsRegeneration) {
      const text = second.narrativesByItemId.get(item.id);
      if (text && checkNarrativeGrounding(text, byId.get(item.id)!.factorJson).grounded) grounded.set(item.id, text);
      // else: falls back to numbers-only (no entry in `grounded`) per docs/09 §8.
    }
  }

  return { narrativesByItemId: grounded, costUsd: totalCost };
}
