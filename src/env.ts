import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;

  // vars
  NEW_SOURCE_WINDOW_DAYS: string;
  HALOPSA_BASE_URL: string;
  /** Must match the URI the Halo OAuth app allowlists, character for character. */
  HALOPSA_OAUTH_REDIRECT_URI: string;
  /**
   * Comma-separated Halo agent ids allowed to run fleet-wide map changes
   * (dmarc_set_domain_map with replace=true) from the per-user route.
   * Everything else is open to any signed-in agent.
   */
  DMARC_ADMIN_AGENT_IDS?: string;

  // secrets
  /** Bearer token for /mcp (service path: n8n and legacy Desktop configs). */
  MCP_AUTH_TOKEN: string;
  N8N_ALERT_WEBHOOK?: string;
  /** Halo authorization-code app for /mcp/user. Halo delegates the login to Entra SSO. */
  HALOPSA_OAUTH_CLIENT_ID: string;
  HALOPSA_OAUTH_CLIENT_SECRET: string;

  /** Grant, token and client storage for @cloudflare/workers-oauth-provider. Binding name fixed by the library. */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider on every request it routes. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * Who made this request. For the audit log and for the admin gate on fleet-wide
 * writes — nothing else. clientName is self-asserted at dynamic client
 * registration, so it identifies the AI, never the permission.
 */
export interface CallerIdentity {
  authPath: 'user' | 'service';
  clientId?: string;
  clientName?: string;
  agentId?: number;
  agentName?: string;
  agentEmail?: string;
}

/**
 * What tool handlers receive. Env is assignable to it, so the ingest and
 * scheduled paths are unaffected.
 *
 * haloToken is present only on /mcp/user: the signed-in agent's own Halo token.
 * This worker still holds no Halo service identity — anything it reads from
 * Halo, it reads as the person asking.
 */
export interface ToolContext extends Env {
  haloToken?: () => Promise<string>;
  caller?: CallerIdentity;
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

/** Service path is trusted (it holds the bearer secret). User path must be on the admin list. */
export function isAdmin(ctx: ToolContext): boolean {
  if (ctx.caller?.authPath === 'service') return true;
  const id = ctx.caller?.agentId;
  if (id === undefined) return false;
  const allowed = String(ctx.DMARC_ADMIN_AGENT_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return allowed.includes(id);
}
