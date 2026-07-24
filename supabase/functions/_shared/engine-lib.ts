/**
 * Single point of contact with packages/engine (pure, isomorphic Deno+Node scoring/allocation/
 * tax logic). Every Edge Function imports from here, never reaches across to packages/engine
 * directly, so the cross-package relative path is written exactly once (mirrors shared-lib.ts).
 */
export * from '../../../packages/engine/src/index.ts';
