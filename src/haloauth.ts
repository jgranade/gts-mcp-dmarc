import { Env } from './env.js';
import { fetchWithTimeout } from './halo.js';

/**
 * Halo as the identity provider for /mcp/user.
 *
 * Ported from the HaloPSA worker (gts/mcp/halo/src/haloauth.ts), where it was
 * verified by hand against the GTS instance: confidential client (secret
 * required), no PKCE, granted scope `openid email profile offline_access roles
 * all:standard`. Halo hands the login to Entra SSO, so the agent signs in with
 * the same Microsoft account they use for Halo itself.
 *
 * Why Halo rather than Entra directly: every tech who needs this is already a
 * Halo agent, the flow is already proven, and the resulting token lets this
 * worker read the client's Email Domains field as the agent — which is what
 * makes dmarc_sync_client a one-step operation.
 *
 * Keep this file in step with the Halo worker's copy. If a fix lands there, it
 * belongs here too.
 */

export const HALO_SCOPE = 'all offline_access';

/** Force a refresh this far ahead of the Halo token's own expiry. See clientTokenTTL. */
export const REFRESH_MARGIN_SECONDS = 300;
const MAX_CLIENT_TOKEN_TTL_SECONDS = 3600;
const MIN_CLIENT_TOKEN_TTL_SECONDS = 60;

export interface HaloUserProps {
  agentId: number;
  agentName: string;
  agentEmail: string;
  clientId?: string;
  clientName?: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the Halo access token expires. */
  expiresAt: number;
}

export type HaloGrantIdentity = Pick<
  HaloUserProps,
  'agentId' | 'agentName' | 'agentEmail' | 'clientId' | 'clientName'
>;

export interface HaloTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

/** Keeps the HTTP status so a dead grant (400/401) is distinguishable from Halo being unwell. */
export class HaloAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HaloAuthError';
  }
}

function authOrigin(env: Env): string {
  return env.HALOPSA_BASE_URL.replace(/\/api\/?$/, '');
}

export function buildHaloAuthorizeUrl(env: Env, state: string): string {
  const url = new URL(`${authOrigin(env)}/auth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.HALOPSA_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.HALOPSA_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', HALO_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

async function haloTokenRequest(env: Env, form: Record<string, string>, label: string): Promise<HaloTokenSet> {
  const response = await fetchWithTimeout(`${authOrigin(env)}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new HaloAuthError(response.status, `HaloPSA ${label} failed: ${response.status} ${text}`);
  }

  let parsed: HaloTokenSet;
  try {
    parsed = JSON.parse(text) as HaloTokenSet;
  } catch {
    throw new HaloAuthError(response.status, `HaloPSA ${label} returned a non-JSON body: ${text.slice(0, 500)}`);
  }
  if (!parsed.access_token) {
    throw new HaloAuthError(response.status, `HaloPSA ${label} returned no access_token: ${text.slice(0, 500)}`);
  }
  return parsed;
}

export function exchangeAuthorizationCode(env: Env, code: string): Promise<HaloTokenSet> {
  return haloTokenRequest(
    env,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.HALOPSA_OAUTH_REDIRECT_URI,
      client_id: env.HALOPSA_OAUTH_CLIENT_ID,
      client_secret: env.HALOPSA_OAUTH_CLIENT_SECRET,
    },
    'authorization_code exchange'
  );
}

export function refreshAccessToken(env: Env, refreshToken: string): Promise<HaloTokenSet> {
  return haloTokenRequest(
    env,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.HALOPSA_OAUTH_CLIENT_ID,
      client_secret: env.HALOPSA_OAUTH_CLIENT_SECRET,
    },
    'refresh_token exchange'
  );
}

/** GET /Agent/me — confirms the token is a real agent and gives a stable grant owner id. */
export async function resolveAgentIdentity(
  env: Env,
  accessToken: string
): Promise<Pick<HaloUserProps, 'agentId' | 'agentName' | 'agentEmail'>> {
  const response = await fetchWithTimeout(`${env.HALOPSA_BASE_URL}/Agent/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new HaloAuthError(response.status, `HaloPSA GET /Agent/me failed: ${response.status} ${text}`);
  }

  const agent = JSON.parse(text) as Record<string, unknown>;
  const agentId = Number(agent.id);
  if (!Number.isFinite(agentId)) {
    throw new HaloAuthError(
      response.status,
      `HaloPSA GET /Agent/me returned no usable agent id. Is the signing-in account an agent? ` +
        `Body: ${text.slice(0, 500)}`
    );
  }

  return {
    agentId,
    agentName: String(agent.name ?? ''),
    agentEmail: String(agent.emailaddress ?? ''),
  };
}

export function applyTokenSet(
  tokens: HaloTokenSet,
  identity: HaloGrantIdentity,
  previousRefreshToken?: string
): HaloUserProps {
  // Halo usually rotates the refresh token but is not guaranteed to return one.
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new HaloAuthError(
      400,
      `HaloPSA returned no refresh token and none was held. ` +
        `Confirm the OAuth app requests the "${HALO_SCOPE}" scope.`
    );
  }

  return {
    ...identity,
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

/** Our token expires REFRESH_MARGIN_SECONDS before Halo's, so the client refreshes while Halo's is still live. */
export function clientTokenTTL(props: HaloUserProps): number {
  const haloRemaining = Math.floor((props.expiresAt - Date.now()) / 1000);
  const ttl = Math.min(haloRemaining - REFRESH_MARGIN_SECONDS, MAX_CLIENT_TOKEN_TTL_SECONDS);
  return Math.max(ttl, MIN_CLIENT_TOKEN_TTL_SECONDS);
}
