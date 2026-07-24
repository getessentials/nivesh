import { assertEquals } from '@std/assert';
import { usageCostUsd, calendarMonthStart, RESEARCH_MODEL, NARRATIVE_MODEL } from './llm.ts';

Deno.test('usageCostUsd computes plain input+output cost with no cache activity', () => {
  const cost = usageCostUsd(NARRATIVE_MODEL, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assertEquals(cost, 1.0 + 5.0); // Haiku 4.5: $1/$5 per MTok
});

Deno.test('usageCostUsd adds cache write/read at their multipliers of the input rate', () => {
  const cost = usageCostUsd(RESEARCH_MODEL, {
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
  });
  // Sonnet 5: $3/MTok input -> write 1.25x = 3.75, read 0.1x = 0.3
  assertEquals(cost, 3.75 + 0.3);
});

Deno.test('usageCostUsd throws for an unpriced model rather than silently returning 0', () => {
  let threw = false;
  try {
    usageCostUsd('claude-made-up-model', { input_tokens: 1, output_tokens: 1 });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('calendarMonthStart normalizes any date within a month to that month\'s first day', () => {
  assertEquals(calendarMonthStart('2026-07-23'), '2026-07-01');
  assertEquals(calendarMonthStart('2026-07-01'), '2026-07-01');
  assertEquals(calendarMonthStart('2026-12-31'), '2026-12-01');
});
