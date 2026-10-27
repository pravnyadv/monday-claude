const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalize, labelsFromSettings, blocksToMarkdown, detectColumn, resolvePerson,
  statusColumnValues, assigneeColumnValues, nextDelay, createClient, resolveToken,
  resolveBody, writeFileAtomic,
} = require('../mon.js');

test('resolveBody: inline text stays literal; @file and a bare existing path are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monbody-'));
  const f = path.join(dir, 'body.html');
  fs.writeFileSync(f, '<p>from file</p>');
  assert.equal(resolveBody('<p>inline</p>'), '<p>inline</p>');   // literal (has '<')
  assert.equal(resolveBody('just words'), 'just words');          // literal (no such file)
  assert.equal(resolveBody('@' + f), '<p>from file</p>');         // explicit @file
  assert.equal(resolveBody(f), '<p>from file</p>');               // bare existing path
  assert.equal(resolveBody('<a>' + f + '</a>'), '<a>' + f + '</a>'); // HTML never treated as a path
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: writes content and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monatomic-'));
  const f = path.join(dir, 'ref.json');
  writeFileAtomic(f, '{"ok":true}\n');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(dir), ['ref.json']); // no *.tmp leftover
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveToken: env wins over saved; falls back to saved; null when neither; ignores blanks', () => {
  assert.equal(resolveToken({ env: 'E', saved: 'S' }), 'E');
  assert.equal(resolveToken({ env: '  ', saved: 'S' }), 'S');
  assert.equal(resolveToken({ env: undefined, saved: 'S' }), 'S');
  assert.equal(resolveToken({ env: '', saved: '' }), null);
  assert.equal(resolveToken({ env: null, saved: null }), null);
});

test('normalize: new (id-keyed) shape passes through', () => {
  const raw = {
    endpoint: 'E', apiVersion: 'V', tokenEnvVar: 'TK',
    self: { id: '1' }, people: { Alex: '9' },
    boards: {
      '111': { id: 111, name: 'B', statusColumn: 'status', assigneeColumn: 'person',
        columns: { status: { title: 'Status', type: 'status' } }, statusLabels: { Done: 1 } },
    },
  };
  const ref = normalize(raw);
  assert.equal(ref.endpoint, 'E');
  assert.equal(ref.tokenEnvVar, 'TK');
  assert.deepEqual(ref.people, { Alex: '9' });
  assert.equal(ref.boards['111'].statusColumn, 'status');
  assert.equal(ref.boards['111'].statusLabels.Done, 1);
});

test('normalize: legacy (role-keyed) shape is adapted to canonical', () => {
  const raw = {
    boards: {
      main: { id: 111, name: 'Board A', columns: { techStatus: 'dup__of_status', assignee: 'person' } },
      subitems: { id: 222, name: 'Subs', columns: { techStatus: 'color_x', assignee: 'people' } },
    },
    techStatusLabels: {
      main: { 'Ready for Q/A': 7, Done: 1 },
      subitems: { Done: 1 },
    },
    people: { 'Alex Doe': '100' },
  };
  const ref = normalize(raw);
  const b = ref.boards['111'];
  assert.equal(b.statusColumn, 'dup__of_status');
  assert.equal(b.assigneeColumn, 'person');
  assert.equal(b.statusLabels['Ready for Q/A'], 7);
  assert.equal(ref.boards['222'].assigneeColumn, 'people');
  assert.equal(ref.endpoint, 'https://api.monday.com/v2');
  assert.equal(ref.tokenEnvVar, 'monday_api_key');
});

test('normalize: empty config yields defaults and no boards', () => {
  const ref = normalize({});
  assert.deepEqual(ref.boards, {});
  assert.deepEqual(ref.people, {});
  assert.equal(ref.apiVersion, '2026-04');
});

test('labelsFromSettings: drops deactivated labels', () => {
  const settings = JSON.stringify({ labels: { '1': 'Done', '2': 'Stuck', '5': 'Old' }, deactivated_labels: [5] });
  assert.deepEqual(labelsFromSettings(settings), { Done: 1, Stuck: 2 });
});

test('labelsFromSettings: tolerates empty/missing', () => {
  assert.deepEqual(labelsFromSettings('{}'), {});
  assert.deepEqual(labelsFromSettings(undefined), {});
});

test('detectColumn: prefers exact type over legacy alias', () => {
  const cols = [{ id: 'a', type: 'color' }, { id: 'b', type: 'status' }];
  assert.equal(detectColumn(cols, new Set(['status', 'color']), 'status'), 'b');
});

test('detectColumn: falls back to first match, null when none', () => {
  const cols = [{ id: 'x', type: 'color' }, { id: 'y', type: 'text' }];
  assert.equal(detectColumn(cols, new Set(['status', 'color']), 'status'), 'x');
  assert.equal(detectColumn(cols, new Set(['people']), 'people'), null);
});

test('resolvePerson: id passes through, exact + unique-prefix resolve, _note skipped', () => {
  const people = { _note: 'skip me', 'Alex Doe': '100', 'Sam Roe': '200' };
  assert.equal(resolvePerson(people, '999'), '999');
  assert.equal(resolvePerson(people, 'alex doe'), '100');
  assert.equal(resolvePerson(people, 'sam'), '200');
  assert.throws(() => resolvePerson(people, 'nobody'), /Unknown person/);
  assert.throws(() => resolvePerson(people, 'nobody'), /mon\.js refresh/);
});

test('resolvePerson: exact match wins over a longer name it prefixes; ambiguous prefix throws', () => {
  const people = { Sam: '1', Samuel: '2', Samantha: '3' };
  assert.equal(resolvePerson(people, 'sam'), '1'); // exact beats prefix
  assert.equal(resolvePerson(people, 'sama'), '3'); // unique prefix -> Samantha
  assert.equal(resolvePerson(people, 'samu'), '2');
  assert.throws(() => resolvePerson({ Samuel: '2', Samantha: '3' }, 'sam'), /Ambiguous person "sam": Samuel, Samantha/);
});

test('statusColumnValues + assigneeColumnValues build the exact JSON monday expects', () => {
  assert.equal(statusColumnValues('dup__of_status', 'Ready for Q/A'),
    '{"dup__of_status":{"label":"Ready for Q/A"}}');
  assert.equal(assigneeColumnValues('person', ['100', 200]),
    '{"person":{"personsAndTeams":[{"id":100,"kind":"person"},{"id":200,"kind":"person"}]}}');
});

test('nextDelay: honors Retry-After seconds, else exponential and capped', () => {
  assert.equal(nextDelay(0, '3'), 3000);
  assert.equal(nextDelay(10, '100'), 30000); // Retry-After capped at 30s
  assert.ok(nextDelay(0) >= 500 && nextDelay(0) < 800);
  assert.ok(nextDelay(2) >= 2000 && nextDelay(2) < 2300);
  assert.equal(nextDelay(20), 30000); // backoff capped
});

test('createClient: retries on 429 then succeeds, returns data', async () => {
  const calls = [];
  const responses = [
    { status: 429, headers: { get: () => '0' }, json: async () => ({}) },
    { status: 200, headers: { get: () => null }, json: async () => ({ data: { ok: 1 } }) },
  ];
  const client = createClient({
    endpoint: 'x', apiVersion: 'v', token: 't',
    fetch: async (url, opts) => { calls.push(JSON.parse(opts.body)); return responses.shift(); },
    sleepFn: async () => {},
  });
  const data = await client.api('query{ok}', { a: 1 });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls.length, 2); // retried once
  assert.equal(calls[0].variables.a, 1);
});

test('createClient: retries complexity errors returned as HTTP 200', async () => {
  const responses = [
    { status: 200, headers: { get: () => null }, json: async () => ({ errors: [{ message: 'Complexity budget exhausted' }] }) },
    { status: 200, headers: { get: () => null }, json: async () => ({ data: { ok: true } }) },
  ];
  const client = createClient({
    endpoint: 'x', apiVersion: 'v', token: 't',
    fetch: async () => responses.shift(), sleepFn: async () => {},
  });
  assert.deepEqual(await client.api('q'), { ok: true });
});

test('createClient: surfaces a real API error without retrying forever', async () => {
  const client = createClient({
    endpoint: 'x', apiVersion: 'v', token: 't',
    fetch: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ errors: [{ message: 'Item not found' }] }) }),
    sleepFn: async () => {},
  });
  await assert.rejects(() => client.api('q'), /Item not found/);
});

test('blocksToMarkdown: text, lists, and image blocks', () => {
  const blocks = [
    { type: 'normal text', content: JSON.stringify({ deltaFormat: [{ insert: 'hello ' }, { insert: 'world' }] }) },
    { type: 'bulleted list', content: JSON.stringify({ deltaFormat: [{ insert: 'a point' }] }) },
    { type: 'image', content: JSON.stringify({ url: 'https://x/y/pic.png', assetId: 42 }) },
  ];
  assert.equal(blocksToMarkdown(blocks), 'hello world\n- a point\n![pic.png](assetId:42)');
});
