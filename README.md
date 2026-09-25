# gts-dmarc-mcp

DMARC aggregate report ingest and query, as one Cloudflare Worker.

Three entry points in a single Worker:

- **`email`** — Cloudflare Email Routing delivers reports to `rua@granadeops.com`.
  The Worker decompresses (`.gz`, `.zip`, bare `.xml`), parses the aggregate XML,
  and writes to D1. Idempotent on `report_id`.
- **`/mcp/user`** — MCP tools, per-user OAuth. Halo is the identity provider and
  hands the login to Entra SSO, so any Halo agent connects from Claude (web,
  desktop, mobile) or the GTS Copilot agent with no local config. Same wiring as
  `/mcp/user` on the HaloPSA worker.
- **`/mcp`** — the same tools behind the shared bearer token. Service path for
  n8n and legacy Desktop configs.
- **`scheduled`** — nightly: post new failing sources to n8n, which opens the
  Halo ticket.

## Source of record

Halo owns domain → client, in the client custom field **Email Domains**
(`CFClientEmailDomains`, comma-separated). D1 holds a cache plus the DMARC state
(policy, alignment, sources).

This worker holds **no Halo service identity**. On `/mcp/user` it reads Halo with
the signed-in agent's own token, which is how `dmarc_sync_client` works: edit
Email Domains in Halo, then "Sync DMARC domains for Halo client 42". The sync is
exact for that client and never touches another client's rows.

`/mcp` has no Halo token at all, so `dmarc_sync_client` refuses there; use
`dmarc_set_domain_map` with pairs read through the HaloPSA MCP.

Drift is still possible — edit Halo and forget to sync. A report whose domain
matches no client lands in `unmapped`, which makes that visible. Work it to
empty.

`dmarc_set_domain_map` with `replace=true` rewrites the whole map. On `/mcp/user`
it is limited to `DMARC_ADMIN_AGENT_IDS`; dry runs are open to everyone.

## Setup

```bash
npm install

# 1. Database
npx wrangler d1 create gts-dmarc          # paste the id into wrangler.toml
npm run db:init

# 2. OAuth storage — paste the id into wrangler.toml [[kv_namespaces]]
npx wrangler kv namespace create OAUTH_KV

# 3. Secrets
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put N8N_ALERT_WEBHOOK            # optional
npx wrangler secret put HALOPSA_OAUTH_CLIENT_ID      # Halo OAuth app, redirect
npx wrangler secret put HALOPSA_OAUTH_CLIENT_SECRET  # https://dmarc.mcp.granadeops.com/callback

# 4. Deploy, then wire Email Routing in the dashboard:
#    granadeops.com > Email > Email Routing > Routes
#    rua@granadeops.com -> Send to Worker -> gts-dmarc-mcp
npm run deploy
```

## DNS

On the reporting domain, once:

```
*._report._dmarc.granadeops.com   TXT   "v=DMARC1"
```

Without it, receivers refuse to send reports for other domains to this address.

On each monitored domain:

```
_dmarc.example.com   TXT   "v=DMARC1; p=none; rua=mailto:rua@granadeops.com"
```

Reports are not retroactive. The monitoring window starts when reports begin
arriving, not when the record is published.

## Tools

| Tool | Use |
|---|---|
| `dmarc_domain_summary` | Is this domain safe to tighten? |
| `dmarc_sources` | Which sender is blocking enforcement? |
| `dmarc_list_domains` | Fleet posture, who is still at `p=none` |
| `dmarc_unmapped_domains` | Halo Email Domains audit |
| `dmarc_new_failing_sources` | What is pending alert |
| `dmarc_sync_client` | Sync one Halo client's Email Domains (per-user only) |
| `dmarc_set_domain_map` | Low-level push of domain → client pairs; bulk loads |

## Notes

- The `email` handler never rejects. A bounced report is lost permanently —
  reporters do not retry on 5xx — so parse failures are logged and accepted.
- Alerts are marked sent only after n8n returns 2xx, so a webhook outage retries
  the next night rather than dropping the alert.
- Sender labelling (IP → "Microsoft 365", "Mailchimp") is not implemented. The
  schema has a `label` column on `source_seen` for it. Do it once there is real
  data to label.
