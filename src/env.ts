export interface Env {
  DB: D1Database;

  // vars
  NEW_SOURCE_WINDOW_DAYS: string;

  // secrets
  MCP_AUTH_TOKEN: string;
  N8N_ALERT_WEBHOOK?: string;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Normalize a domain the same way everywhere: lowercase, strip a leading @,
 * strip a trailing dot, trim. Report XML and Halo values both go through this,
 * which is the only reason they ever match.
 */
export function normalizeDomain(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\.$/, '');
}
