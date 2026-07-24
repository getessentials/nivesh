/**
 * Owner-admin visibility is a client-side UX hint ONLY (docs/09 §2.1's ADMIN_USER_IDS allowlist
 * is enforced server-side, in the Edge Functions themselves — this env var never grants access,
 * it just avoids showing admin-only UI to an obviously non-admin session).
 */
const ADMIN_USER_IDS = (import.meta.env.VITE_ADMIN_USER_IDS as string | undefined)?.split(',').filter(Boolean) ?? [];

export function isAdminUser(userId: string): boolean {
  return ADMIN_USER_IDS.includes(userId);
}
