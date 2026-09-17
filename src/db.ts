import { Env, normalizeDomain, nowSec } from './env.js';
import type { DmarcReport } from './ingest/parse.js';

export interface StoreResult {
  stored: boolean;
  reason?: string;
  domain: string;
  record_count: number;
  mapped_client_id: number | null;
}

/**
 * Idempotent on report_id. Reporters resend and Email Routing can redeliver;
 * neither should double-count volume.
 */
export async function storeReport(env: Env, report: DmarcReport): Promise<StoreResult> {
  const existing = await env.DB.prepare('SELECT report_id FROM reports WHERE report_id = ?')
    .bind(report.report_id)
    .first();

  const mapping = await env.DB.prepare('SELECT client_id FROM domain_map WHERE domain = ?')
    .bind(report.domain)
    .first<{ client_id: number | null }>();

  if (existing) {
    return {
      stored: false,
      reason: 'duplicate report_id',
      domain: report.domain,
      record_count: 0,
      mapped_client_id: mapping?.client_id ?? null,
    };
  }

  const ts = nowSec();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO reports (report_id, org_name, org_email, domain, date_begin, date_end,
         policy_p, policy_sp, policy_pct, policy_adkim, policy_aspf, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      report.report_id,
      report.org_name,
      report.org_email,
      report.domain,
      report.date_begin,
      report.date_end,
      report.policy_p,
      report.policy_sp,
      report.policy_pct,
      report.policy_adkim,
      report.policy_aspf,
      ts
    ),
  ];

  for (const r of report.records) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO records (report_id, domain, source_ip, count, disposition,
           dkim_aligned, spf_aligned, header_from, dkim_domain, spf_domain, date_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        report.report_id,
        report.domain,
        r.source_ip,
        r.count,
        r.disposition,
        r.dkim_aligned ? 1 : 0,
        r.spf_aligned ? 1 : 0,
        r.header_from,
        r.dkim_domain,
        r.spf_domain,
        report.date_end
      )
    );

    statements.push(
      env.DB.prepare(
        `INSERT INTO source_seen (domain, source_ip, first_seen, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(domain, source_ip) DO UPDATE SET last_seen = excluded.last_seen`
      ).bind(report.domain, r.source_ip, ts, ts)
    );
  }

  if (!mapping) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO unmapped (domain, first_seen, last_seen, report_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(domain) DO UPDATE SET
           last_seen = excluded.last_seen,
           report_count = unmapped.report_count + 1`
      ).bind(report.domain, ts, ts)
    );
  }

  await env.DB.batch(statements);

  return {
    stored: true,
    domain: report.domain,
    record_count: report.records.length,
    mapped_client_id: mapping?.client_id ?? null,
  };
}

export interface DomainSummary {
  domain: string;
  client_id: number | null;
  client_name: string | null;
  policy: string | null;
  days: number;
  total_messages: number;
  aligned_messages: number;
  alignment_pct: number;
  failing_sources: number;
  last_report: number | null;
}

export async function domainSummary(
  env: Env,
  domain: string,
  days: number
): Promise<DomainSummary> {
  const since = nowSec() - days * 86400;

  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(count), 0) AS total,
       COALESCE(SUM(CASE WHEN dkim_aligned = 1 OR spf_aligned = 1 THEN count ELSE 0 END), 0) AS aligned,
       COUNT(DISTINCT CASE WHEN dkim_aligned = 0 AND spf_aligned = 0 THEN source_ip END) AS failing_sources
     FROM records WHERE domain = ? AND date_end >= ?`
  )
    .bind(domain, since)
    .first<{ total: number; aligned: number; failing_sources: number }>();

  const latest = await env.DB.prepare(
    `SELECT policy_p, date_end FROM reports WHERE domain = ? ORDER BY date_end DESC LIMIT 1`
  )
    .bind(domain)
    .first<{ policy_p: string | null; date_end: number }>();

  const mapping = await env.DB.prepare(
    `SELECT client_id, client_name FROM domain_map WHERE domain = ?`
  )
    .bind(domain)
    .first<{ client_id: number | null; client_name: string | null }>();

  const total = totals?.total ?? 0;
  const aligned = totals?.aligned ?? 0;

  return {
    domain,
    client_id: mapping?.client_id ?? null,
    client_name: mapping?.client_name ?? null,
    policy: latest?.policy_p ?? null,
    days,
    total_messages: total,
    aligned_messages: aligned,
    alignment_pct: total > 0 ? Math.round((aligned / total) * 1000) / 10 : 0,
    failing_sources: totals?.failing_sources ?? 0,
    last_report: latest?.date_end ?? null,
  };
}

export async function domainSources(
  env: Env,
  domain: string,
  days: number,
  failingOnly: boolean
) {
  const since = nowSec() - days * 86400;
  const having = failingOnly ? 'HAVING aligned = 0' : '';

  const { results } = await env.DB.prepare(
    `SELECT r.source_ip,
            SUM(r.count) AS messages,
            SUM(CASE WHEN r.dkim_aligned = 1 OR r.spf_aligned = 1 THEN r.count ELSE 0 END) AS aligned,
            MAX(r.dkim_domain) AS dkim_domain,
            MAX(r.spf_domain) AS spf_domain,
            MIN(s.first_seen) AS first_seen,
            MAX(s.label) AS label
     FROM records r
     LEFT JOIN source_seen s ON s.domain = r.domain AND s.source_ip = r.source_ip
     WHERE r.domain = ? AND r.date_end >= ?
     GROUP BY r.source_ip
     ${having}
     ORDER BY messages DESC
     LIMIT 100`
  )
    .bind(domain, since)
    .all();

  return results;
}

export async function allDomains(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT d.domain, d.client_id, d.client_name, d.source,
            (SELECT policy_p FROM reports r WHERE r.domain = d.domain
               ORDER BY date_end DESC LIMIT 1) AS policy,
            (SELECT MAX(date_end) FROM reports r WHERE r.domain = d.domain) AS last_report
     FROM domain_map d
     ORDER BY d.client_name, d.domain`
  ).all();

  return results;
}

export async function unmappedDomains(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT domain, first_seen, last_seen, report_count
     FROM unmapped ORDER BY last_seen DESC`
  ).all();
  return results;
}

/** Sources first seen inside the window that are failing and not yet alerted. */
export async function newFailingSources(env: Env, windowDays: number) {
  const since = nowSec() - windowDays * 86400;

  const { results } = await env.DB.prepare(
    `SELECT s.domain, s.source_ip, s.first_seen,
            m.client_id, m.client_name,
            SUM(r.count) AS messages
     FROM source_seen s
     JOIN records r ON r.domain = s.domain AND r.source_ip = s.source_ip
     LEFT JOIN domain_map m ON m.domain = s.domain
     WHERE s.first_seen >= ?
       AND s.alerted_at IS NULL
       AND r.dkim_aligned = 0 AND r.spf_aligned = 0
     GROUP BY s.domain, s.source_ip
     ORDER BY messages DESC`
  )
    .bind(since)
    .all();

  return results as unknown as Array<{
    domain: string;
    source_ip: string;
    first_seen: number;
    client_id: number | null;
    client_name: string | null;
    messages: number;
  }>;
}

export interface DomainMapEntry {
  domain: string;
  client_id: number;
  client_name: string;
}

export interface SetMapResult {
  submitted: number;
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  rejected: string[];
  replace: boolean;
  dry_run: boolean;
}

/**
 * Reconcile the domain -> client map against what the caller supplies.
 *
 * Halo remains the source of record; this is its cache. Entries land with
 * source='halo'. Rows added by hand (source='local') are never touched, so
 * exceptions Halo cannot express survive every push.
 *
 * replace=true removes halo-sourced rows absent from the payload, which is what
 * you want after reading ALL clients. replace=false only adds and updates,
 * which is what you want when pushing a single client.
 */
export async function setDomainMap(
  env: Env,
  entries: DomainMapEntry[],
  replace: boolean,
  dryRun: boolean
): Promise<SetMapResult> {
  const desired = new Map<string, DomainMapEntry>();
  const rejected: string[] = [];

  for (const e of entries) {
    const domain = normalizeDomain(e.domain);
    // A dotless value can never match a report's policy domain. Refuse it here
    // rather than storing a row that silently maps nothing.
    if (!domain.includes('.')) {
      rejected.push(String(e.domain));
      continue;
    }
    desired.set(domain, { domain, client_id: e.client_id, client_name: e.client_name });
  }

  const { results } = await env.DB.prepare(
    `SELECT domain, client_id FROM domain_map WHERE source = 'halo'`
  ).all<{ domain: string; client_id: number }>();

  const current = new Map((results ?? []).map((r) => [r.domain, r.client_id]));

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const [domain, info] of desired) {
    if (!current.has(domain)) added.push(domain);
    else if (current.get(domain) !== info.client_id) updated.push(domain);
    else unchanged++;
  }

  if (replace) {
    for (const domain of current.keys()) {
      if (!desired.has(domain)) removed.push(domain);
    }
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
    submitted: entries.length,
    added,
    updated,
    removed,
    unchanged,
    rejected,
    replace,
    dry_run: dryRun,
  };
}

export async function markAlerted(env: Env, pairs: Array<{ domain: string; source_ip: string }>) {
  if (pairs.length === 0) return;
  const ts = nowSec();
  await env.DB.batch(
    pairs.map((p) =>
      env.DB.prepare(
        `UPDATE source_seen SET alerted_at = ? WHERE domain = ? AND source_ip = ?`
      ).bind(ts, p.domain, p.source_ip)
    )
  );
}
