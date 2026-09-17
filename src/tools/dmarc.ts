import { Env, normalizeDomain } from '../env.js';
import {
  allDomains,
  domainSources,
  domainSummary,
  unmappedDomains,
  newFailingSources,
  setDomainMap,
  type DomainMapEntry,
} from '../db.js';

const DEFAULT_DAYS = 30;

export const dmarcTools = [
  {
    name: 'dmarc_domain_summary',
    description:
      'Posture for one domain over a window: published policy, message volume, percentage of ' +
      'mail passing DMARC alignment, count of distinct failing sources, and the Halo client it ' +
      'maps to. This is the tool to answer "is it safe to tighten this domain to quarantine or ' +
      'reject" — a domain at 100% alignment with no failing sources for a full window is ready; ' +
      'anything less means a legitimate sender would break. Also use it to enrich a deliverability ' +
      'ticket before writing the triage note.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The organizational domain, e.g. chambersida.com. Case and @ are tolerated.',
        },
        days: {
          type: 'number',
          description: `Lookback window in days. Default ${DEFAULT_DAYS}.`,
        },
      },
      required: ['domain'],
    },
    handler: async (env: Env, args: Record<string, unknown>) =>
      domainSummary(env, normalizeDomain(args.domain), Number(args.days ?? DEFAULT_DAYS)),
  },
  {
    name: 'dmarc_sources',
    description:
      'Every sending source seen for a domain in the window, with message counts, how much of ' +
      'that volume aligned, the DKIM/SPF domains observed, and when the source was first seen. ' +
      'Set failing_only to isolate the sources blocking enforcement. Use this when the summary ' +
      'shows a domain is not clean and you need to know which sender to fix.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The organizational domain.' },
        days: { type: 'number', description: `Lookback window in days. Default ${DEFAULT_DAYS}.` },
        failing_only: {
          type: 'boolean',
          description: 'Only return sources where no mail aligned. Default false.',
        },
      },
      required: ['domain'],
    },
    handler: async (env: Env, args: Record<string, unknown>) =>
      domainSources(
        env,
        normalizeDomain(args.domain),
        Number(args.days ?? DEFAULT_DAYS),
        Boolean(args.failing_only)
      ),
  },
  {
    name: 'dmarc_list_domains',
    description:
      'Every domain being monitored, with its Halo client, current published policy, and when ' +
      'its last report arrived. Use this for fleet-wide questions: which domains are still at ' +
      'p=none, which have gone quiet (no recent report usually means the rua was removed or the ' +
      'domain stopped sending), and which clients are covered at all.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (env: Env) => allDomains(env),
  },
  {
    name: 'dmarc_unmapped_domains',
    description:
      'Domains that have sent reports but match no Halo client. Each entry means a client ' +
      "Email Domains field is missing a domain, or a domain nobody has claimed. This is the " +
      'audit list for keeping Halo accurate — work it down to empty.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (env: Env) => unmappedDomains(env),
  },
  {
    name: 'dmarc_new_failing_sources',
    description:
      'Sources that appeared recently and are failing alignment, across all domains, that have ' +
      'not yet been alerted on. This is what the nightly job sends to n8n; call it directly to ' +
      'see what is pending before the next run.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How far back counts as "new". Default 3.' },
      },
    },
    handler: async (env: Env, args: Record<string, unknown>) =>
      newFailingSources(env, Number(args.days ?? env.NEW_SOURCE_WINDOW_DAYS ?? 3)),
  },
  {
    name: 'dmarc_set_domain_map',
    description:
      'Push the domain-to-client map into this worker. Halo is the source of record for which ' +
      'domains belong to which client (client custom field Email Domains, CFClientEmailDomains); ' +
      'this worker holds no Halo credentials and cannot read it itself. The intended flow is: read ' +
      'the clients through the HaloPSA MCP in a session authenticated as a real user, split each ' +
      "client's Email Domains value on commas, and pass the pairs here.\n\n" +
      'Set replace=true only when passing EVERY client, since it deletes mapped domains absent ' +
      'from the payload. Leave it false when correcting a single client. Rows added by hand ' +
      '(source=local) are never touched either way. Use dry_run to preview the reconcile.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          description: 'One entry per domain. A client with three domains contributes three entries.',
          items: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'A single sending domain. Case, @ and trailing dots are tolerated.',
              },
              client_id: { type: 'number', description: 'HaloPSA client id.' },
              client_name: { type: 'string', description: 'HaloPSA client name, for display.' },
            },
            required: ['domain', 'client_id', 'client_name'],
          },
        },
        replace: {
          type: 'boolean',
          description:
            'Delete mapped domains not present in entries. Only safe when passing every client. ' +
            'Default false.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Report what would change without writing. Default false.',
        },
      },
      required: ['entries'],
    },
    handler: async (env: Env, args: Record<string, unknown>) =>
      setDomainMap(
        env,
        (args.entries ?? []) as DomainMapEntry[],
        Boolean(args.replace),
        Boolean(args.dry_run)
      ),
  },
];
