/**
 * Single point of contact with packages/shared (pure, isomorphic Deno+Node logic — parsers,
 * calendar, sanity gates, metrics, zod schemas). Every Edge Function imports from here, never
 * reaches across to packages/shared directly, so the cross-package relative path is written
 * exactly once.
 */
export * from '../../../packages/shared/src/index.ts';
