import { assertEquals, assertThrows } from '@std/assert';
import { verifyCronSecret } from './auth.ts';

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = Deno.env.get(k);
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) Deno.env.delete(k);
      else Deno.env.set(k, prev[k]!);
    }
  }
}

Deno.test('verifyCronSecret accepts a matching secret', () => {
  withEnv({ CRON_SECRET: 'topsecret123' }, () => {
    const req = new Request('https://x.test', { headers: { 'x-cron-secret': 'topsecret123' } });
    verifyCronSecret(req); // must not throw
  });
});

Deno.test('verifyCronSecret rejects a wrong secret', () => {
  withEnv({ CRON_SECRET: 'topsecret123' }, () => {
    const req = new Request('https://x.test', { headers: { 'x-cron-secret': 'wrong' } });
    const err = assertThrows(() => verifyCronSecret(req));
    assertEquals((err as { status?: number }).status, 401);
  });
});

Deno.test('verifyCronSecret rejects a missing header', () => {
  withEnv({ CRON_SECRET: 'topsecret123' }, () => {
    const req = new Request('https://x.test');
    assertThrows(() => verifyCronSecret(req));
  });
});

Deno.test('verifyCronSecret rejects a same-length wrong secret (not just length mismatch)', () => {
  withEnv({ CRON_SECRET: 'aaaaaaaaaa' }, () => {
    const req = new Request('https://x.test', { headers: { 'x-cron-secret': 'aaaaaaaaab' } });
    assertThrows(() => verifyCronSecret(req));
  });
});

Deno.test('verifyCronSecret throws if CRON_SECRET itself is unset (fails closed, not open)', () => {
  withEnv({}, () => {
    Deno.env.delete('CRON_SECRET');
    const req = new Request('https://x.test', { headers: { 'x-cron-secret': 'anything' } });
    assertThrows(() => verifyCronSecret(req));
  });
});
