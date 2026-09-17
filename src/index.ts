import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { Env } from './env.js';
import { dmarcTools } from './tools/dmarc.js';
import { handleReportEmail } from './ingest/email.js';
import { markAlerted, newFailingSources } from './db.js';

const allTools = [...dmarcTools];

/** Build a zod type for one JSON-schema node. Handles object and array nesting. */
function buildZodType(schema: Record<string, unknown>): z.ZodTypeAny {
  const describe = (t: z.ZodTypeAny) => t.describe(String(schema.description ?? ''));

  if (schema.type === 'number') return describe(z.number());
  if (schema.type === 'boolean') return describe(z.boolean());

  if (schema.type === 'array') {
    const items = (schema.items ?? { type: 'string' }) as Record<string, unknown>;
    return describe(z.array(buildZodType(items)));
  }

  if (schema.type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    const required = schema.required as string[] | undefined;
    return describe(z.object(buildZodShape(props, required)));
  }

  return describe(z.string());
}

function buildZodShape(properties: Record<string, unknown>, required?: string[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, schema] of Object.entries(properties)) {
    let zField = buildZodType(schema as Record<string, unknown>);
    if (!required?.includes(key)) {
      zField = zField.optional();
    }
    shape[key] = zField;
  }
  return shape;
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: 'gts-dmarc-mcp', version: '1.0.0' });

  for (const tool of allTools) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const required = (tool.inputSchema as Record<string, unknown>).required as string[] | undefined;
    const shape = buildZodShape(props, required);

    server.tool(tool.name, tool.description, shape, async (args) => {
      try {
        const result = await tool.handler(env, args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    });
  }

  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', server: 'gts-dmarc-mcp' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/mcp') {
      const authHeader = request.headers.get('Authorization');
      if (!env.MCP_AUTH_TOKEN || authHeader !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }

      const server = createMcpServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response('Not found', { status: 404 });
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
   * The domain map is NOT refreshed here. This worker holds no Halo credentials —
   * the map is pushed in via dmarc_set_domain_map from a session already
   * authenticated as a real user. Drift surfaces in the unmapped table rather
   * than requiring a service identity to prevent it.
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

    // Only mark alerted once n8n has it, so a webhook outage retries tomorrow
    // rather than silently swallowing the alert.
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
