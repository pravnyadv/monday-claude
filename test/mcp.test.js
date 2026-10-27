const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpClient, parseRpc, isReadOnlyTool } = require('../lib/mcp');

test('parseRpc: plain JSON and server-sent events', () => {
  assert.deepEqual(parseRpc('{"result":1}'), { result: 1 });
  assert.deepEqual(parseRpc('event: message\ndata: {"result":2}\n\n'), { result: 2 });
});

test('isReadOnlyTool: only read-only hints, and never the feedback tool', () => {
  assert.equal(isReadOnlyTool({ name: 'get_updates', annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnlyTool({ name: 'create_update', annotations: { readOnlyHint: false } }), false);
  assert.equal(isReadOnlyTool({ name: 'x' }), false);
  assert.equal(isReadOnlyTool({ name: 'submit_bug_or_feature_request', annotations: { readOnlyHint: true } }), false);
});

function fakeServer(replies) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const result = replies[calls.length - 1];
    return { ok: true, status: 200, headers: { get: (h) => (h === 'mcp-session-id' ? 'sess-1' : null) }, text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: calls.length, result })}\n` };
  };
  return { fetch, calls };
}

test('createMcpClient: initializes once, sends the bearer token and session id, parses JSON text', async () => {
  const { fetch, calls } = fakeServer([{}, { content: [{ type: 'text', text: '{"ok":true}' }] }, { content: [{ type: 'text', text: 'plain' }] }]);
  const c = createMcpClient({ token: 'T', fetch });
  assert.deepEqual(await c.call('get_user_context'), { ok: true });
  assert.equal(await c.call('explore_meetings', { limit: 1 }), 'plain');
  assert.deepEqual(calls.map((x) => x.body.method), ['initialize', 'tools/call', 'tools/call']);
  assert.equal(calls[0].headers.Authorization, 'Bearer T');
  assert.equal(calls[1].headers['Mcp-Session-Id'], 'sess-1');
  assert.deepEqual(calls[2].body.params, { name: 'explore_meetings', arguments: { limit: 1 } });
});

test('createMcpClient: tool errors throw, whether flagged or written as "Error:" text', async () => {
  const { fetch } = fakeServer([{}, { isError: true, content: [{ type: 'text', text: 'bad args' }] }, { content: [{ type: 'text', text: 'Error: nope' }] }]);
  const c = createMcpClient({ token: 'T', fetch });
  await assert.rejects(() => c.call('a'), /a: bad args/);
  await assert.rejects(() => c.call('b'), /b: nope/);
});
