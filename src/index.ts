import OAuthProvider, {
  AuthorizationError,
  OAuthError,
  type AuthRequest,
} from '@cloudflare/workers-oauth-provider';
import { Env } from './env.js';
import { rejectStreamingGet, serveMcp } from './mcp.js';
import { handleReportEmail } from './ingest/email.js';
import { markAlerted, newFailingSources } from './db.js';
import {
  applyTokenSet,
  buildHaloAuthorizeUrl,
  clientTokenTTL,
  exchangeAuthorizationCode,
  HaloAuthError,
  HaloUserProps,
  refreshAccessToken,
  resolveAgentIdentity,
} from './haloauth.js';

/**
 * Three entry points, two MCP routes.
 *
 *   email       DMARC aggregate reports from Cloudflare Email Routing. Untouched by auth.
 *   scheduled   Nightly new-failing-source alert to n8n. Untouched by auth.
 *   fetch       /mcp        bearer MCP_AUTH_TOKEN. Service path for n8n and existing
 *                           Desktop configs. Behaviour unchanged.
 *               /mcp/user   OAuth, Halo as the identity provider (Halo delegates to Entra
 *                           SSO). The Claude / Copilot connector for every tech.
 *
 * The OAuth wiring is ported from the HaloPSA worker, where it is in production. Read
 * gts/mcp/halo/src/index.ts for the reasoning behind each piece; the comments here are
 * the short version.
 *
 * IMPORTANT: OAuthProvider only implements fetch. The default export below must keep
 * email and scheduled alongside it — drop email and reports bounce, and a bounced DMARC
 * report is gone for good.
 */

/** Env for tokenExchangeCallback, which the library calls without one. Constant per deployment. */
let lastSeenEnv: Env | null = null;

const AUTH_REQUEST_PREFIX = 'dmarc:authreq:';
/** Long enough for an Entra SSO prompt with MFA; short enough to be useless if leaked. */
const AUTH_REQUEST_TTL_SECONDS = 600;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function errorPage(title: string, detail: string, status = 400): Response {
  return htmlResponse(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font:14px/1.5 system-ui;max-width:44rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.2rem">${escapeHtml(title)}</h1>` +
      `<pre style="white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:6px">${escapeHtml(detail)}</pre>` +
      `</body>`,
    status
  );
}

/**
 * Explicit approval before the Halo redirect. Without it, anyone could register a client
 * via DCR and bounce an agent with a live Halo session straight through to their own
 * redirect URI (confused deputy). Naming the client and destination makes that obvious.
 */
function consentPage(clientName: string, redirectUri: string, formAction: string): Response {
  return htmlResponse(
    `<!doctype html><meta charset="utf-8"><title>Authorize GTS DMARC access</title>` +
      `<body style="font:14px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">Authorize GTS DMARC access</h1>` +
      `<p><strong>${escapeHtml(clientName)}</strong> is asking to use the GTS DMARC tools as you.</p>` +
      `<p style="color:#52525b">You will sign in with your Halo account next (Microsoft sign-in). ` +
      `DMARC reports are read-only; mapping changes are logged under your name. Client details ` +
      `are read from Halo with your own permissions.</p>` +
      `<p style="color:#52525b">Sends results to: <code>${escapeHtml(redirectUri)}</code><br>` +
      `If you did not start this, close this page.</p>` +
      `<form method="post" action="${escapeHtml(formAction)}">` +
      `<button type="submit" style="font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;` +
      `background:#18181b;color:#fff;cursor:pointer">Continue to sign-in</button>` +
      `</form></body>`
  );
}

/** 401 that sends an MCP client to refresh rather than give up. */
function invalidToken(request: Request, description: string): Response {
  const url = new URL(request.url);
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate':
        `Bearer error="invalid_token", error_description="${description.replace(/"/g, "'")}", ` +
        `resource_metadata="${metadataUrl}"`,
    },
  });
}

/** GET /authorize shows consent; POST /authorize hands off to Halo. */
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) {
      return errorPage('Authorization request rejected', `${error.code}: ${error.description}`);
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set('error', error.code);
    redirect.searchParams.set('error_description', error.description);
    if (error.state) redirect.searchParams.set('state', error.state);
    if (error.issuer) redirect.searchParams.set('iss', error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return errorPage('Unknown OAuth client', `No client is registered under id ${oauthRequest.clientId}.`);
  }

  if (request.method === 'GET') {
    return consentPage(client.clientName || oauthRequest.clientId, oauthRequest.redirectUri, url.pathname + url.search);
  }

  // A cross-site POST would skip the consent page it exists to enforce.
  const origin = request.headers.get('Origin');
  if (origin !== url.origin) {
    return errorPage(
      'Authorization request rejected',
      `This approval must be submitted from ${url.origin}. Start again from the beginning.`,
      403
    );
  }

  // Halo echoes state verbatim; keep the real request in KV and send an opaque handle.
  const stateKey = crypto.randomUUID();
  await env.OAUTH_KV.put(AUTH_REQUEST_PREFIX + stateKey, JSON.stringify(oauthRequest), {
    expirationTtl: AUTH_REQUEST_TTL_SECONDS,
  });

  return Response.redirect(buildHaloAuthorizeUrl(env, stateKey), 302);
}

/** GET /callback — Halo is done with the browser; turn its code into a grant. */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const haloError = url.searchParams.get('error');
  if (haloError) {
    return errorPage(
      'Halo declined the sign-in',
      `${haloError}: ${url.searchParams.get('error_description') ?? '(no description given)'}`
    );
  }

  const code = url.searchParams.get('code');
  const stateKey = url.searchParams.get('state');
  if (!code || !stateKey) {
    return errorPage('Invalid callback', 'Halo returned no authorization code or no state value.');
  }

  const stored = await env.OAUTH_KV.get(AUTH_REQUEST_PREFIX + stateKey);
  if (!stored) {
    return errorPage(
      'Authorization request expired',
      `This sign-in took longer than ${AUTH_REQUEST_TTL_SECONDS / 60} minutes, or the link was already used. Start again from your MCP client.`
    );
  }
  // Single use, deleted before the exchange so a replayed callback cannot reuse it.
  await env.OAUTH_KV.delete(AUTH_REQUEST_PREFIX + stateKey);
  const oauthRequest = JSON.parse(stored) as AuthRequest;
  const grantClient = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);

  let props: HaloUserProps;
  try {
    const tokens = await exchangeAuthorizationCode(env, code);
    const identity = await resolveAgentIdentity(env, tokens.access_token);
    props = applyTokenSet(tokens, {
      ...identity,
      clientId: oauthRequest.clientId,
      clientName: grantClient?.clientName,
    });
  } catch (error) {
    return errorPage('Halo rejected the authorization', error instanceof Error ? error.message : String(error));
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    // Grants are per agent per client: re-authorizing replaces rather than accumulates.
    userId: String(props.agentId),
    metadata: {
      agentName: props.agentName,
      agentEmail: props.agentEmail,
      authorizedAt: new Date().toISOString(),
    },
    scope: oauthRequest.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
}

/** /mcp/user. The library has already validated the bearer and decrypted the grant into ctx.props. */
const userApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'GET') return rejectStreamingGet();

    const props = (ctx as ExecutionContext & { props?: HaloUserProps }).props;
    if (!props?.accessToken) {
      return invalidToken(request, 'This grant carries no Halo credentials. Reconnect the connector.');
    }
    if (props.expiresAt <= Date.now()) {
      return invalidToken(request, 'The Halo access token behind this grant has expired.');
    }

    return serveMcp(request, {
      ...env,
      haloToken: async () => props.accessToken,
      caller: {
        authPath: 'user',
        clientId: props.clientId,
        clientName: props.clientName,
        agentId: props.agentId,
        agentName: props.agentName,
        agentEmail: props.agentEmail,
      },
    });
  },
};

/** Everything that is not /mcp/user. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', server: 'gts-dmarc-mcp' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Service path. Unchanged apart from the caller tag for the audit log.
    if (url.pathname === '/mcp') {
      const authHeader = request.headers.get('Authorization');
      if (!env.MCP_AUTH_TOKEN || authHeader !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      return serveMcp(request, { ...env, caller: { authPath: 'service' } });
    }

    if (url.pathname === '/authorize' && (request.method === 'GET' || request.method === 'POST')) {
      return handleAuthorize(request, env);
    }

    if (url.pathname === '/callback') {
      return handleCallback(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: '/mcp/user',
  apiHandler: userApiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  // Claude and Copilot Studio both use dynamic client registration.
  clientRegistrationEndpoint: '/register',

  /** Refresh Halo's token underneath ours, before it expires. See the Halo worker for the full reasoning. */
  tokenExchangeCallback: async (options) => {
    const env = lastSeenEnv;
    if (!env) {
      throw new OAuthError('server_error', {
        description: 'Worker environment unavailable during token exchange',
        statusCode: 500,
      });
    }

    const props = options.props as HaloUserProps;

    if (options.grantType === 'authorization_code') {
      return { accessTokenTTL: clientTokenTTL(props) };
    }

    if (options.grantType === 'refresh_token') {
      let next: HaloUserProps;
      try {
        const tokens = await refreshAccessToken(env, props.refreshToken);
        next = applyTokenSet(tokens, props, props.refreshToken);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof HaloAuthError ? error.status : 0;
        // 400/401: grant is dead, send the agent back through SSO. Anything else is Halo
        // being unwell, and must not log everyone out.
        if (status === 400 || status === 401) {
          throw new OAuthError('invalid_grant', { description: message });
        }
        throw new OAuthError('temporarily_unavailable', { description: message, statusCode: 503 });
      }
      return { newProps: next, accessTokenTTL: clientTokenTTL(next) };
    }

    return undefined;
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    lastSeenEnv = env;
    return provider.fetch(request, env, ctx);
  },

  /**
   * Inbound DMARC aggregate reports, routed here by Cloudflare Email Routing.
   * Never reject: a bounced report is a report lost for good, and reporters do
   * not resend on a 5xx. Parse failures are logged and the message accepted.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      const results = await handleReportEmail(env, message.raw);
      for (const r of results) {
        console.log(
          JSON.stringify({
            event: 'dmarc_report_stored',
            domain: r.domain,
            stored: r.stored,
            reason: r.reason,
            records: r.record_count,
            client_id: r.mapped_client_id,
          })
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'dmarc_report_failed',
          from: message.from,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  },

  /**
   * Nightly: push new failing sources to n8n.
   *
   * The domain map is NOT refreshed here. This worker holds no Halo service
   * identity; the map is maintained by dmarc_sync_client, which reads Halo as
   * the signed-in agent. Drift still surfaces in the unmapped table.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const windowDays = Number(env.NEW_SOURCE_WINDOW_DAYS ?? 3);
    const pending = await newFailingSources(env, windowDays);
    if (pending.length === 0) return;

    if (!env.N8N_ALERT_WEBHOOK) {
      console.log(JSON.stringify({ event: 'alerts_pending_no_webhook', count: pending.length }));
      return;
    }

    const res = await fetch(env.N8N_ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'gts-dmarc-mcp', sources: pending }),
    });

    // Only mark alerted once n8n has it, so a webhook outage retries tomorrow.
    if (res.ok) {
      await markAlerted(
        env,
        pending.map((p) => ({ domain: p.domain, source_ip: p.source_ip }))
      );
    } else {
      console.error(JSON.stringify({ event: 'alert_webhook_failed', status: res.status }));
    }
  },
};
