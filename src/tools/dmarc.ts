import { ToolContext as Env, isAdmin, normalizeDomain } from '../env.js';
import { getClientEmailDomains } from '../halo.js';
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
    name: 'dmarc_sync_client',
    description:
      "Sync one Halo client's Email Domains (custom field CFClientEmailDomains) into the DMARC " +
      'domain map, reading Halo as the signed-in agent. This is the normal way to map domains: ' +
      'after editing the Email Domains field in Halo, call this with the client id. The sync is ' +
      "exact for that client — domains added in Halo are mapped, domains removed from that client's " +
      'field are unmapped, and a domain previously mapped to a different client moves to this one. ' +
      "Other clients' mappings are never touched. Use dry_run to preview. Only available on the " +
      'per-user connector.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number', description: 'HaloPSA client id.' },
        dry_run: {
          type: 'boolean',
          description: 'Report what would change without writing. Default false.',
        },
      },
      required: ['client_id'],
    },
    handler: async (ctx: Env, args: Record<string, unknown>) => {
      const clientId = Number(args.client_id);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('client_id must be a positive Halo client id.');
      }
      const dryRun = Boolean(args.dry_run);
      const halo = await getClientEmailDomains(ctx, clientId);

      const result = await setDomainMap(
        ctx,
        halo.domains.map((domain) => ({
          domain,
          client_id: halo.client_id,
          client_name: halo.client_name,
        })),
        true, // exact for this client...
        dryRun,
        halo.client_id // ...and only this client
      );

      const warnings: string[] = [];
      if (halo.domains.length === 0) {
        warnings.push(
          'Email Domains is empty in Halo for this client. Any domains previously mapped to it ' +
            (dryRun ? 'would be' : 'were') +
            ' unmapped.'
        );
      }
      if (halo.inactive) warnings.push('This client is inactive in Halo.');
      if (result.updated.length > 0) {
        warnings.push(
          `Moved from another client: ${result.updated.join(', ')}. Confirm the domain was ` +
            'removed from the other client in Halo, or the next sync of that client will move it back.'
        );
      }

      return {
        client_id: halo.client_id,
        client_name: halo.client_name,
        halo_email_domains: halo.raw,
        ...result,
        warnings,
      };
    },
  },
  {
    name: 'dmarc_set_domain_map',
    description:
      'Low-level push of domain-to-client pairs into the map. For a single client, prefer ' +
      'dmarc_sync_client, which reads Halo itself and cannot get the list wrong. Use this for ' +
      'bulk loads or when working from the service connector, which has no Halo access: read ' +
      "the clients through the HaloPSA MCP, split each client's Email Domains on commas, and " +
      'pass the pairs here.\n\n' +
      'Set replace=true only when passing EVERY client, since it deletes mapped domains absent ' +
      'from the payload; on the per-user connector it is restricted to GTS admins. Rows added ' +
      'by hand (source=local) are never touched. Use dry_run to preview the reconcile.',
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
    handler: async (env: Env, args: Record<string, unknown>) => {
      const replace = Boolean(args.replace);
      const dryRun = Boolean(args.dry_run);
      // A dry run changes nothing, so anyone may preview a fleet-wide reconcile.
      if (replace && !dryRun && !isAdmin(env)) {
        throw new Error(
          'replace=true rewrites the whole domain map and is restricted to GTS admins. ' +
            'To correct one client, use dmarc_sync_client instead.'
        );
      }
      return setDomainMap(env, (args.entries ?? []) as DomainMapEntry[], replace, dryRun);
    },
  },
];
