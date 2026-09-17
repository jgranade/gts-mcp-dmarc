import { XMLParser } from 'fast-xml-parser';
import { normalizeDomain } from '../env.js';

export interface DmarcRecord {
  source_ip: string;
  count: number;
  disposition: string | null;
  dkim_aligned: boolean;
  spf_aligned: boolean;
  header_from: string | null;
  dkim_domain: string | null;
  spf_domain: string | null;
}

export interface DmarcReport {
  report_id: string;
  org_name: string;
  org_email: string | null;
  domain: string;
  date_begin: number;
  date_end: number;
  policy_p: string | null;
  policy_sp: string | null;
  policy_pct: number | null;
  policy_adkim: string | null;
  policy_aspf: string | null;
  records: DmarcRecord[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
});

/** Reporters emit a single <record> as an object and several as an array. */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const str = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s.length > 0 ? s : null;
};

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function parseAggregateReport(xml: string): DmarcReport {
  const doc = parser.parse(xml) as Record<string, any>;
  const fb = doc.feedback;
  if (!fb) throw new Error('Not a DMARC aggregate report: no <feedback> element');

  const meta = fb.report_metadata ?? {};
  const policy = fb.policy_published ?? {};
  const domain = normalizeDomain(policy.domain);

  if (!domain) throw new Error('Report has no policy_published.domain');

  const records: DmarcRecord[] = asArray(fb.record).map((r: any) => {
    const row = r?.row ?? {};
    const evaluated = row.policy_evaluated ?? {};
    const identifiers = r?.identifiers ?? {};
    const auth = r?.auth_results ?? {};

    // A report can carry several DKIM signatures; aligned-if-any matches how
    // receivers evaluate it.
    const dkimPass = asArray<any>(auth.dkim).some(
      (d) => String(d?.result ?? '').toLowerCase() === 'pass'
    );
    const spfPass = asArray<any>(auth.spf).some(
      (s) => String(s?.result ?? '').toLowerCase() === 'pass'
    );

    return {
      source_ip: String(row.source_ip ?? '').trim(),
      count: num(row.count, 0),
      disposition: str(evaluated.disposition),
      // policy_evaluated is the alignment verdict; auth_results is the raw check.
      // Prefer the verdict, fall back to the raw result.
      dkim_aligned: String(evaluated.dkim ?? '').toLowerCase() === 'pass' || dkimPass,
      spf_aligned: String(evaluated.spf ?? '').toLowerCase() === 'pass' || spfPass,
      header_from: normalizeDomain(identifiers.header_from) || null,
      dkim_domain: normalizeDomain(asArray<any>(auth.dkim)[0]?.domain) || null,
      spf_domain: normalizeDomain(asArray<any>(auth.spf)[0]?.domain) || null,
    };
  });

  const range = meta.date_range ?? {};

  return {
    report_id: String(meta.report_id ?? '').trim() || `${meta.org_name}-${range.end}`,
    org_name: String(meta.org_name ?? 'unknown').trim(),
    org_email: str(meta.email),
    domain,
    date_begin: num(range.begin),
    date_end: num(range.end),
    policy_p: str(policy.p),
    policy_sp: str(policy.sp),
    policy_pct: policy.pct === undefined ? null : num(policy.pct, 100),
    policy_adkim: str(policy.adkim),
    policy_aspf: str(policy.aspf),
    records: records.filter((r) => r.source_ip.length > 0),
  };
}
