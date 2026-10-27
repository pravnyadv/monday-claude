/**
 * A minimal client for monday's hosted MCP server (https://mcp.monday.com/mcp), authenticated with
 * the same personal API token as the GraphQL client, so every call acts as the token owner.
 *
 * GraphQL stays the backbone: it is versioned, while the MCP tool surface is not (tools get renamed
 * and argument types differ between tools). Use this only for what GraphQL lacks: meetings, board
 * insights, automations, and the `mcp` passthrough.
 */

const MCP_URL = 'https://mcp.monday.com/mcp';
const PROTOCOL = '2025-06-18';

/** Tools that look read-only by their hint but send something to monday staff. */
const NEVER_PASSTHROUGH = new Set(['submit_bug_or_feature_request']);

/** A JSON-RPC body from either a plain JSON response or a server-sent-events stream. */
function parseRpc(text) {
  const events = [...String(text).matchAll(/^data: (.+)$/gm)].map((m) => m[1]);

  return JSON.parse(events.length ? events[events.length - 1] : text);
}

function createMcpClient({ token, url = MCP_URL, fetch: fetchImpl = globalThis.fetch }) {
  let sessionId = null;
  let initialized = null;
  let nextId = 0;
  let toolCache = null;

  async function rpc(method, params = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    });
    sessionId = res.headers?.get?.('mcp-session-id') || sessionId;
    const text = await res.text();
    if (!res.ok) throw new Error(`monday MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = parseRpc(text);
    if (body.error) throw new Error(`monday MCP error: ${body.error.message}`);

    return body.result;
  }

  const ready = () => (initialized ??= rpc('initialize', {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mon.js', version: '1' },
  }));

  async function tools() {
    await ready();

    return (toolCache ??= (await rpc('tools/list')).tools);
  }

  /** Call a tool and return its text (parsed as JSON when it is JSON). Tool-level errors throw. */
  async function call(name, args = {}) {
    await ready();
    const result = await rpc('tools/call', { name, arguments: args });
    const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result.isError || /^Error:/.test(text)) throw new Error(`${name}: ${text.replace(/^Error:\s*/, '').slice(0, 600)}`);
    if (result.structuredContent) return result.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return { tools, call };
}

/** Whether the passthrough may run `tool` without --write. */
function isReadOnlyTool(tool) {
  return !!tool?.annotations?.readOnlyHint && !NEVER_PASSTHROUGH.has(tool.name);
}

module.exports = { createMcpClient, parseRpc, isReadOnlyTool, NEVER_PASSTHROUGH, MCP_URL };
