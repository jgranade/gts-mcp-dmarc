import { Env, normalizeDomain, nowSec } from './env.js';

interface HaloCustomField {
  name?: string;
  value?: unknown;
}

interface HaloClient {
  id: number;
  name: string;
  inactive?: boolean;
  customfields?: HaloCustomField[];
}

async function getToken(env: Env): Promise<string> {
  const authUrl = env.HALOPSA_BASE_URL.replace(/\/api\/?$/, '') + '/auth/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.HALOPSA_CLIENT_ID,
    client_secret: env.HALOPSA_CLIENT_SECRET,
    scope: 'all',
  });

  const res = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Halo auth failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function haloGet<T>(env: Env, token: string, path: string): Promise<T> {
  const res = await fetch(`${env.HALOPSA_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Halo GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface SyncResult {
  clients_checked: number;
  domains_found: number;
  added: string[];
  removed: string[];
  unchanged: number;
  dry_run: boolean;
}

/**
 * Pull the Email Domains custom field from every active Halo client and reconcile
 * domain_map against it. Halo is the source of record; rows with source='local'
 * are left alone so hand-added exceptions survive a sync.
 */
export async function syncDomainMap(env: Env, dryRun = false): Promise<SyncResult> {
  const token = await getToken(env);
  const fieldName = env.HALO_EMAIL_DOMAINS_FIELD;

  const list = await haloGet<{ clients: HaloClient[] }>(env, token, '/Client?includeinactive=false');
  const clients = list.clients ?? [];

  const desired = new Map<string, { client_id: number; client_name: string }>();

  for (const summary of clients) {
    // The list endpoint does not reliably include customfields, so read each client.
    const full = await haloGet<HaloClient>(env, token, `/Client/${summary.id}`);
    if (full.inactive) continue;

    const field = (full.customfields ?? []).find((f) => f.name === fieldName);
    const raw = String(field?.value ?? '').trim();
    if (!raw) continue;

    for (const part of raw.split(',')) {
      const domain = normalizeDomain(part);
      if (domain.includes('.')) {
        desired.set(domain, { client_id: full.id, client_name: full.name });
      }
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT domain, client_id FROM domain_map WHERE source = 'halo'`
  ).all<{ domain: string; client_id: number }>();

  const current = new Map((results ?? []).map((r) => [r.domain, r.client_id]));

  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const [domain, info] of desired) {
    if (current.get(domain) === info.client_id) unchanged++;
    else added.push(domain);
  }
  for (const domain of current.keys()) {
    if (!desired.has(domain)) removed.push(domain);
  }

  if (!dryRun) {
    const ts = nowSec();
    const statements: D1PreparedStatement[] = [];

    for (const [domain, info] of desired) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO domain_map (domain, client_id, client_name, source, updated_at)
           VALUES (?, ?, ?, 'halo', ?)
           ON CONFLICT(domain) DO UPDATE SET
             client_id = excluded.client_id,
             client_name = excluded.client_name,
             source = 'halo',
             updated_at = excluded.updated_at`
        ).bind(domain, info.client_id, info.client_name, ts)
      );
      // A domain that now maps is no longer unmapped.
      statements.push(env.DB.prepare(`DELETE FROM unmapped WHERE domain = ?`).bind(domain));
    }

    for (const domain of removed) {
      statements.push(
        env.DB.prepare(`DELETE FROM domain_map WHERE domain = ? AND source = 'halo'`).bind(domain)
      );
    }

    if (statements.length > 0) await env.DB.batch(statements);
  }

  return {
    clients_checked: clients.length,
    domains_found: desired.size,
    added,
    removed,
    unchanged,
    dry_run: dryRun,
  };
}
