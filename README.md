# gts-dmarc-mcp

DMARC aggregate report ingest and query, as one Cloudflare Worker.

Three entry points in a single Worker:

- **`email`** — Cloudflare Email Routing delivers reports to `rua@granadeops.com`.
  The Worker decompresses (`.gz`, `.zip`, bare `.xml`), parses the aggregate XML,
  and writes to D1. Idempotent on `report_id`.
- **`/mcp`** — MCP tools for querying posture. Bearer-token auth, same pattern as
  the other GTS MCP workers.
- **`scheduled`** — nightly: refresh the Halo domain map, then post new failing
  sources to n8n, which opens the Halo ticket.

## Source of record

Halo owns domain → client, in the client custom field **Email Domains**
(`CFClientEmailDomains`, comma-separated). D1 holds a cache plus the DMARC state
(policy, alignment, sources). The field is resolved **by name**, never by its
numeric id.

A report whose domain matches no client lands in `unmapped`. That table is the
audit of missing Email Domains values — work it to empty.

## Setup

```bash
npm install

# 1. Database
npx wrangler d1 create gts-dmarc          # paste the id into wrangler.toml
npm run db:init

# 2. Secrets
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put HALOPSA_CLIENT_ID
npx wrangler secret put HALOPSA_CLIENT_SECRET
npx wrangler secret put N8N_ALERT_WEBHOOK

# 3. Deploy, then wire Email Routing in the dashboard:
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
| `dmarc_sync_domain_map` | Pull Halo changes now instead of waiting for the cron |

## Notes

- The `email` handler never rejects. A bounced report is lost permanently —
  reporters do not retry on 5xx — so parse failures are logged and accepted.
- Alerts are marked sent only after n8n returns 2xx, so a webhook outage retries
  the next night rather than dropping the alert.
- Sender labelling (IP → "Microsoft 365", "Mailchimp") is not implemented. The
  schema has a `label` column on `source_seen` for it. Do it once there is real
  data to label.
