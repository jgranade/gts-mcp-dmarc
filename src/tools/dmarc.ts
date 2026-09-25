import { ToolContext as Env, isAdmin, normalizeDomain } from '../env.js';
import { getClientEmailDomains } from '../halo.js';
import { resolveClient } from '../clients.js';
import {
  allDomains,
  clientMappedDomains,
  domainSources,
  domainSummary,
  unmappedDomains,
  newFailingSources,
  setDomainMap,
  type DomainMapEntry,
} from '../db.js';

const DEFAULT_DAYS = 30;

const CLIENT_PROPS = {
  client_name: {
    type: 'string',
    description:
      'Halo client name as a tech would say it, e.g. "Turner Fence". An exact name wins; if the ' +
      'name is ambiguous the tool returns the candidates with ids instead of guessing.',
  },
  client_id: {
    type: 'number',
    description: 'HaloPSA client id. Use instead of client_name when known.',
  },
};

export const dmarcTools = [
  {
    name: 'dmarc_client_summary',
    description:
      'DMARC posture for every domain of one client in a single call: per domain, the published ' +
      'policy, message volume, alignment %, failing source count, and last report. Accepts the ' +
      'client name. This is the tool for "DMARC summary for Turner Fence" and for Day 2 / Day 7 ' +
      'checks in the rollout runbook. On the per-user connector it also compares the map with the ' +
      "client's Email Domains field in Halo and lists anything not yet synced.",
    inputSchema: {
      type: 'object',
      properties: {
        ...CLIENT_PROPS,
        days: { type: 'number', description: `Lookback window in days. Default ${DEFAULT_DAYS}.` },
      },
    },
    handler: async (ctx: Env, args: Record<string, unknown>) => {
      const client = await resolveClient(ctx, args);
      const days = Number(args.days ?? DEFAULT_DAYS);

      const mapped = await clientMappedDomains(ctx, client.id);
      const domains = await Promise.all(mapped.map((m) => domainSummary(ctx, m.domain, days)));

      // Drift check against Halo, when we can read it. This is the "edited but
      // not synced" case surfacing on its own instead of in Troubleshooting.
      let halo_drift: { in_halo_not_mapped: string[]; mapped_not_in_halo: string[] } | null = null;
      let clientName = client.name || mapped[0]?.client_name || '';
      if (ctx.haloToken) {
        const halo = await getClientEmailDomains(ctx, client.id);
        clientName = halo.client_name;
        const mappedSet = new Set(mapped.filter((m) => m.source === 'halo').map((m) => m.domain));
        const haloSet = new Set(halo.domains);
        halo_drift = {
          in_halo_not_mapped: halo.domains.filter((d) => !mappedSet.has(d)),
          mapped_not_in_halo: [...mappedSet].filter((d) => !haloSet.has(d)),
        };
      }

      const inSync =
        halo_drift === null ||
        (halo_drift.in_halo_not_mapped.length === 0 && halo_drift.mapped_not_in_halo.length === 0);

      return {
        client_id: client.id,
        client_name: clientName,
        days,
        domain_count: domains.length,
        domains,
        halo_drift,
        note:
          domains.length === 0
            ? 'No domains are mapped to this client. Fill in Email Domains in Halo, then run dmarc_sync_client.'
            : inSync
              ? undefined
              : 'The map does not match Halo Email Domains. Run dmarc_sync_client for this client.',
      };
    },
  },
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
      'domain map, reading Halo as the signed-in agent. Accepts the client name ("Turner Fence"). ' +
      'This is the normal way to map domains: after editing the Email Domains field in Halo, run ' +
      "this for that client. The sync is exact for that client — domains added in Halo are mapped, " +
      "domains removed from that client's field are unmapped, and a domain previously mapped to a " +
      "different client moves to this one. Other clients' mappings are never touched. Use dry_run " +
      'to preview. Only available on the per-user connector.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CLIENT_PROPS,
        dry_run: {
          type: 'boolean',
          description: 'Report what would change without writing. Default false.',
        },
      },
    },
    handler: async (ctx: Env, args: Record<string, unknown>) => {
      if (!ctx.haloToken) {
        // Fail before name resolution, whose map fallback would otherwise produce a confusing error.
        throw new Error(
          'dmarc_sync_client reads Halo as the signed-in agent and only runs on the per-user ' +
            'connector. Use dmarc_set_domain_map on the service connector.'
        );
      }
      const client = await resolveClient(ctx, args);
      const dryRun = Boolean(args.dry_run);
      const halo = await getClientEmailDomains(ctx, client.id);

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
