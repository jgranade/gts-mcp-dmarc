import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { ToolContext } from './env.js';
import { dmarcTools } from './tools/dmarc.js';

/**
 * The MCP server, shared verbatim by both routes. The only difference between
 * /mcp and /mcp/user is what the context carries: a caller identity and, on the
 * user route, the agent's Halo token.
 */

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

/**
 * One structured line per tool call. Scalar args only (domain, client_id,
 * days, flags) — the entries array of a bulk push is summarized by count so a
 * log line cannot balloon. Never throws.
 */
function logToolCall(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  startedAt: number,
  ok: boolean,
  error?: string
): void {
  try {
    const scalars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (Array.isArray(v)) scalars[`${k}_count`] = v.length;
      else if (v === null || typeof v !== 'object') scalars[k] = v;
    }
    const caller = ctx.caller;
    console.log(
      JSON.stringify({
        evt: 'mcp_tool_call',
        tool,
        ok,
        ms: Date.now() - startedAt,
        auth_path: caller?.authPath ?? 'unknown',
        client_id: caller?.clientId ?? null,
        client_name: caller?.clientName ?? null,
        agent_id: caller?.agentId ?? null,
        agent_email: caller?.agentEmail ?? null,
        args: scalars,
        ...(error ? { error: error.slice(0, 300) } : {}),
      })
    );
  } catch {
    // Deliberately swallowed.
  }
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'gts-dmarc-mcp', version: '1.1.0' });

  for (const tool of allTools) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const required = (tool.inputSchema as Record<string, unknown>).required as string[] | undefined;
    const shape = buildZodShape(props, required);

    server.tool(tool.name, tool.description, shape, async (args) => {
      const startedAt = Date.now();
      const argRecord = args as Record<string, unknown>;
      try {
        const result = await tool.handler(ctx, argRecord);
        logToolCall(ctx, tool.name, argRecord, startedAt, true);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(ctx, tool.name, argRecord, startedAt, false, message);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    });
  }

  return server;
}

/** GET is SSE streaming, which a Worker cannot hold open. Both routes are stateless POST. */
export function rejectStreamingGet(): Response {
  return new Response(
    JSON.stringify({ error: 'SSE streaming not supported. Use POST for MCP requests.' }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } }
  );
}

/** Stateless: a fresh server and transport per request, so no caller outlives its request. */
export async function serveMcp(request: Request, ctx: ToolContext): Promise<Response> {
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}
