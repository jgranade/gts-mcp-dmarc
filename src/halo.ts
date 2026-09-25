import { ToolContext, normalizeDomain } from './env.js';

/**
 * The only Halo reads this worker makes, always with the caller's own token.
 *
 * There is deliberately no client-credentials fallback. On the service path
 * (bearer /mcp) there is no Halo token, and the Halo-backed tools say so rather
 * than quietly acting as a service identity this worker was designed not to hold.
 */

/** Same ceiling as the Halo worker: well above Halo's normal p99, far below the MCP client's. */
export const HALO_REQUEST_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HALO_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error(
        `HaloPSA did not respond within ${HALO_REQUEST_TIMEOUT_MS / 1000}s. ` +
          `This is upstream, not an MCP or auth fault. Retry in a few minutes.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const EMAIL_DOMAINS_FIELD = 'CFClientEmailDomains';

export interface HaloClientDomains {
  client_id: number;
  client_name: string;
  inactive: boolean;
  /** The field exactly as stored in Halo, for the audit trail in the tool result. */
  raw: string;
  domains: string[];
}

export async function getClientEmailDomains(
  ctx: ToolContext,
  clientId: number
): Promise<HaloClientDomains> {
  if (!ctx.haloToken) {
    throw new Error(
      'This tool reads Halo as the signed-in agent and is only available on the per-user ' +
        'connector (/mcp/user). On the service path, read the client through the HaloPSA MCP ' +
        'and use dmarc_set_domain_map instead.'
    );
  }

  const token = await ctx.haloToken();
  const url = `${ctx.HALOPSA_BASE_URL}/Client/${clientId}?includedetails=true`;
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  const text = await response.text();
  if (!response.ok) {
    // Halo's words, verbatim. A 403 here means the agent lacks client access in Halo.
    throw new Error(`HaloPSA GET /Client/${clientId} failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const client = JSON.parse(text) as {
    id?: number;
    name?: string;
    inactive?: boolean;
    customfields?: Array<{ name?: string; value?: unknown }>;
  };

  if (!client.id) {
    throw new Error(`HaloPSA returned no client for id ${clientId}.`);
  }

  const field = (client.customfields ?? []).find((f) => f.name === EMAIL_DOMAINS_FIELD);
  const raw = typeof field?.value === 'string' ? field.value : '';

  // Halo's field regex allows "a.com, b.com" as well as "a.com,b.com". Split on
  // commas and whitespace, normalize, dedupe.
  const domains = [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map(normalizeDomain)
        .filter((d) => d.length > 0)
    ),
  ];

  return {
    client_id: client.id,
    client_name: String(client.name ?? ''),
    inactive: Boolean(client.inactive),
    raw,
    domains,
  };
}
