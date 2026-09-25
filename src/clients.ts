import { ToolContext } from './env.js';
import { searchHaloClients } from './halo.js';
import { findMappedClients } from './db.js';

/**
 * Turn "Turner Fence" or 42 into one Halo client, or refuse.
 *
 * Techs think in client names, not ids, so every client-scoped tool takes either.
 * The rule is: never guess.
 *   - An id is taken as given.
 *   - A name that matches exactly one client (case-insensitive, exact) wins, even
 *     when the search returns others — "Granade Technology Solutions" must not be
 *     ambiguous just because "Granade Farms" exists.
 *   - Otherwise a single match wins, and anything else is an error listing the
 *     candidates with their ids, so the caller can pick one and retry.
 *
 * On /mcp/user the search runs against Halo as the agent. On /mcp (no Halo
 * token) it falls back to client names already in the DMARC map, which is
 * enough for read tools but cannot find a client that has never been synced.
 */
export interface ResolvedClient {
  id: number;
  name: string;
  /** Where the name came from, so a result can say why it picked what it picked. */
  resolved_via: 'id' | 'halo' | 'dmarc_map';
}

export async function resolveClient(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ResolvedClient> {
  const rawId = args.client_id;
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('client_id must be a positive Halo client id.');
    return { id, name: '', resolved_via: 'id' };
  }

  const name = String(args.client_name ?? '').trim();
  if (!name) throw new Error('Pass client_name (e.g. "Turner Fence") or client_id.');

  const fromHalo = Boolean(ctx.haloToken);
  const candidates: Array<{ id: number; name: string }> = fromHalo
    ? (await searchHaloClients(ctx, name)).filter((c) => !c.inactive)
    : await findMappedClients(ctx, name);
  const via = fromHalo ? 'halo' : 'dmarc_map';

  const exact = candidates.filter((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, resolved_via: via };
  if (exact.length === 0 && candidates.length === 1) {
    return { id: candidates[0].id, name: candidates[0].name, resolved_via: via };
  }

  if (candidates.length === 0) {
    throw new Error(
      fromHalo
        ? `No active Halo client matches "${name}". Check the spelling or pass client_id.`
        : `No client named like "${name}" is in the DMARC map. It may never have been synced; ` +
            'use the per-user connector, which searches Halo, or pass client_id.'
    );
  }

  const list = candidates.map((c) => `${c.name} (id ${c.id})`).join('; ');
  throw new Error(
    `"${name}" matches more than one client: ${list}. Ask which one, then retry with its exact name or client_id.`
  );
}
