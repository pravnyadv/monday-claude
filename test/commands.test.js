const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  cmds, setRuntime, parseArgs, isDoneStatus, unansweredMentions, describeActivity, handoffBody, withGreeting,
  defaultHandoffStatus, hookRuns, htmlToText, normalize,
} = require('../mon.js');

const REF = {
  self: { id: '1' },
  people: { Me: '1', 'Alex Morgan': '70000001', 'Jordan Lee': '70000002' },
  boards: { 100: { id: 100, name: 'Board', statusColumn: 'status', assigneeColumn: 'person', columns: {}, statusLabels: { 'Dev In Progress': 0, 'Ready For QA': 8, 'BA Review': 3 } } },
};
const COLUMNS = [{ id: 'status', title: 'Status', type: 'status', settings_str: '{}' }, { id: 'numeric_dev', title: 'Dev Estimate', type: 'numbers' }, { id: 'person', title: 'Person', type: 'people' }];

/** A fake GraphQL client that answers the reads mon.js makes and records every call. */
function fakeApi() {
  const calls = [];
  const api = async (query, vars) => {
    calls.push({ query, vars });
    if (/mutation/.test(query) && /create_update/.test(query)) return { create_update: { id: '555', creator: { name: 'Me' } } };
    if (/change_multiple_column_values/.test(query)) {
      const cv = JSON.parse(vars.cv);
      return { change_multiple_column_values: { column_values: Object.keys(cv).map((id) => ({ id, text: JSON.stringify(cv[id]) })) } };
    }
    if (/edit_update|delete_update/.test(query)) return { edit_update: { id: vars.id, updated_at: 'now' }, delete_update: { id: vars.id } };
    if (/updates\(ids/.test(query)) return { updates: [{ id: '9', item_id: '42', body: '<p><a data-mention-id="70000001">@S</a></p>', text_body: 'x', creator: { name: 'Me' }, replies: [] }] };
    if (/board\{ id name columns/.test(query) || /board\{ id \}/.test(query) || /items\(ids/.test(query)) {
      return { items: [{ id: '42', name: 'Task', url: 'u', group: { title: 'G' }, board: { id: '100', name: 'Board', columns: COLUMNS }, column_values: [] }] };
    }
    throw new Error(`unexpected query ${query}`);
  };
  return { api, calls, mutations: () => calls.filter((c) => /^\s*mutation/.test(c.query)) };
}

test('parseArgs: positionals, booleans, values, repeated and comma lists; unknown flags throw', () => {
  const { positional, flags } = parseArgs(['42', '<p>x</p>', '--cc', 'A,B', '--mr', 'u1', '--mr=u2', '--dry-run', '--to', 'Sub']);
  assert.deepEqual(positional, ['42', '<p>x</p>']);
  assert.deepEqual(flags.cc, ['A', 'B']);
  assert.deepEqual(flags.mr, ['u1', 'u2']);
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.to, 'Sub');
  assert.throws(() => parseArgs(['--bogus']), /Unknown flag --bogus/);
  assert.throws(() => parseArgs(['--to']), /--to needs a value/);
});

test('dry run: update, status, assign, set, edit and delete send no mutation', async () => {
  const f = fakeApi();
  setRuntime({ ref: REF, api: f.api, flags: { 'dry-run': true } });
  const up = await cmds.update(['42', '<p>Hi @Alex</p>']);
  assert.equal(up.dryRun, true);
  assert.match(up.html, /data-mention-id="70000001"/);
  assert.equal((await cmds.status(['42', 'Ready For QA'])).label, 'Ready For QA');
  assert.deepEqual((await cmds.assign(['42', 'Alex'])).people, ['Alex Morgan (70000001)']);
  assert.equal((await cmds.set(['42', 'Dev Estimate', '6'])).value, '6');
  assert.equal((await cmds['update-edit'](['9', '<p>@Alex fixed</p>'])).dryRun, true);
  assert.equal((await cmds['update-delete'](['9'])).dryRun, true);
  assert.deepEqual(f.mutations(), []);
});

test('update-edit refuses to add a mention monday would not ping', async () => {
  const f = fakeApi();
  setRuntime({ ref: REF, api: f.api });
  await assert.rejects(() => cmds['update-edit'](['9', '<p>@Jordan hi</p>']), /can't add mentions .*: Jordan Lee/);
  assert.deepEqual(f.mutations(), []);
});

test('status rejects a label not on the board before any write', async () => {
  const f = fakeApi();
  setRuntime({ ref: REF, api: f.api });
  await assert.rejects(() => cmds.status(['42', 'Ready for QA']), /not a valid status/);
  assert.deepEqual(f.mutations(), []);
});

test('comment no longer takes @Name args (the mentions_list footer path is gone)', async () => {
  setRuntime({ ref: REF, api: fakeApi().api });
  await assert.rejects(() => cmds.comment(['42', '<p>x</p>', '@Jordan']), /no longer takes @Name/);
});

test('handoff: bad input fails before anything is written', async () => {
  const f = fakeApi();
  setRuntime({ ref: REF, api: f.api, flags: { to: 'Alex', status: 'Nope' } });
  await assert.rejects(() => cmds.handoff(['42']), /"Nope" is not a valid status/);
  setRuntime({ ref: REF, api: f.api, flags: { to: 'Nobody' } });
  await assert.rejects(() => cmds.handoff(['42']), /Unknown person "Nobody"/);
  setRuntime({ ref: REF, api: f.api, flags: { to: 'Alex', body: '<p>done — next</p>' } });
  await assert.rejects(() => cmds.handoff(['42']), /writing rules/);
  assert.deepEqual(f.mutations(), []);
});

test('handoff: posts the update first, then status + estimate + assignee in one change, then reads back', async () => {
  const f = fakeApi();
  setRuntime({ ref: REF, api: f.api, flags: { to: 'Alex', mr: ['https://git/x/-/merge_requests/7'], estimate: '6', cc: ['Jordan'] } });
  const r = await cmds.handoff(['42', '<p>this is ready.</p>']);
  const m = f.mutations();
  assert.equal(m.length, 2);
  assert.match(m[0].query, /create_update/);
  assert.match(m[0].vars.b, /^<p><a [^>]*70000001[^>]*>@Alex Morgan<\/a> this is ready\.<\/p><p>MR: <a href="https:\/\/git\/x\/-\/merge_requests\/7">/);
  assert.match(m[0].vars.b, /<p>CC: <a [^>]*70000002/);
  assert.deepEqual(JSON.parse(m[1].vars.cv), { status: { label: 'Ready For QA' }, numeric_dev: '6', person: { personsAndTeams: [{ id: 70000001, kind: 'person' }] } });
  assert.equal(r.status, 'Ready For QA');
  assert.equal(r.item.id, '42');
});

test('handoff dry run returns the full plan and writes nothing', async () => {
  const f = fakeApi();
  setRuntime({ ref: { ...REF, hooks: { handoff: ['echo', '{itemId}', '{mr}'] } }, api: f.api, flags: { to: 'Alex', mr: ['u1', 'u2'], 'dry-run': true } });
  const r = await cmds.handoff(['42']);
  assert.equal(r.dryRun, true);
  assert.equal(r.status, 'Ready For QA');
  assert.deepEqual(r.assignees, ['Alex Morgan']);
  assert.deepEqual(r.hooks, ['echo 42 u1', 'echo 42 u2']);
  assert.deepEqual(f.mutations(), []);
});

test('mcp passthrough: write tools need --write, the feedback tool is never called', async () => {
  const called = [];
  const mcp = {
    tools: async () => [{ name: 'get_updates', annotations: { readOnlyHint: true } }, { name: 'create_item', annotations: { readOnlyHint: false } }, { name: 'submit_bug_or_feature_request', annotations: { readOnlyHint: true } }],
    call: async (name, args) => { called.push(name); return { ok: name, args }; },
  };
  setRuntime({ ref: REF, api: fakeApi().api, mcp });
  assert.deepEqual(await cmds.mcp(['get_updates', '{"objectId":"1"}']), { ok: 'get_updates', args: { objectId: '1' } });
  await assert.rejects(() => cmds.mcp(['create_item', '{}']), /changes data in monday/);
  await assert.rejects(() => cmds.mcp(['submit_bug_or_feature_request', '{}']), /won't call it/);
  setRuntime({ ref: REF, api: fakeApi().api, mcp, flags: { write: true, 'dry-run': true } });
  assert.equal((await cmds.mcp(['create_item', '{"name":"x"}'])).dryRun, true);
  assert.deepEqual(called, ['get_updates']);
});

test('unansweredMentions: a mention counts until I reply in the thread or post later on the item', () => {
  const a = (id) => `<a data-mention-id="${id}">@x</a>`;
  const updates = [
    { id: 'u1', item_id: 'i1', created_at: '2026-10-10T10:00:00Z', creator_id: '2', body: `<p>${a(1)} please check</p>`, replies: [] },
    { id: 'u2', item_id: 'i2', created_at: '2026-10-10T10:00:00Z', creator_id: '2', body: `<p>${a(1)} ?</p>`, replies: [{ id: 'r1', creator_id: '1', created_at: '2026-10-10T11:00:00Z', body: 'done' }] },
    { id: 'u3', item_id: 'i3', created_at: '2026-10-10T10:00:00Z', creator_id: '2', body: `<p>${a(1)}</p>`, replies: [] },
    { id: 'u4', item_id: 'i3', created_at: '2026-10-11T10:00:00Z', creator_id: '1', body: '<p>answered in a new update</p>', replies: [] },
    { id: 'u5', item_id: 'i4', created_at: '2026-10-12T10:00:00Z', creator_id: '1', body: `<p>${a(1)} note to self</p>`, replies: [{ id: 'r2', creator_id: '3', created_at: '2026-10-12T12:00:00Z', body: `${a(1)} reply mentioning me` }] },
    { id: 'u6', item_id: 'i5', created_at: '2026-10-12T10:00:00Z', creator_id: '2', body: '<p>no mention</p>', replies: [] },
  ];
  const out = unansweredMentions(updates, '1');
  assert.deepEqual(out.map((m) => m.messageId), ['r2', 'u1']);
  assert.equal(out[1].text, '@x please check');
  assert.deepEqual(unansweredMentions(updates, '1', Date.parse('2026-10-11T00:00:00Z')).map((m) => m.messageId), ['r2']);
});

test('describeActivity: column changes by type, group moves, follow noise dropped', () => {
  const at = String(Date.parse('2026-10-16T13:11:00Z') * 1e4);
  const row = (event, data) => describeActivity({ event, user_id: 1, created_at: at, data: JSON.stringify(data) }, { Sub: '70000001' });
  assert.equal(row('update_column_value', { column_title: 'Status', previous_value: { label: { text: 'Dev' } }, value: { label: { text: 'QA' } } }).what, 'Status: Dev to QA');
  assert.equal(row('update_column_value', { column_title: 'Est', previous_value: null, value: { value: 6 } }).what, 'Est: (empty) to 6');
  assert.equal(row('update_column_value', { column_title: 'Go', value: { date: '2026-11-06', time: null } }).what, 'Go: (empty) to 2026-11-06');
  assert.equal(row('update_column_value', { column_title: 'P', value: { personsAndTeams: [{ id: 70000001 }] } }).what, 'P: (empty) to Sub');
  assert.equal(row('move_pulse_from_group', { source_group: { title: 'A' }, dest_group: { title: 'B' } }).what, 'moved from group A to B');
  assert.equal(row('subscribe', {}), null);
  assert.equal(row('update_column_value', { column_title: 'S' }).at, '2026-10-16T13:11:00.000Z');
});

test('handoff helpers: body, greeting, default status, hook runs', () => {
  assert.equal(handoffBody(null, { toName: 'Sub', mrs: ['https://g/mr/1'] }), '<p>@{Sub} over to you.</p><p>MR: <a href="https://g/mr/1">https://g/mr/1</a></p>');
  assert.equal(handoffBody('<p>see https://g/mr/1</p>', { toName: 'Sub', mrs: ['https://g/mr/1'] }), '<p>see https://g/mr/1</p>');
  assert.equal(withGreeting('<p>hi</p>', '7', 'A'), '<p>A hi</p>');
  assert.equal(withGreeting('<ul><li>x</li></ul>', '7', 'A'), '<p>A</p><ul><li>x</li></ul>');
  assert.equal(withGreeting('<p><a data-mention-id="7">@S</a> hi</p>', '7', 'A'), '<p><a data-mention-id="7">@S</a> hi</p>');
  assert.equal(defaultHandoffStatus({ statusLabels: { Done: 1, 'Ready for Q/A': 7 } }), 'Ready for Q/A');
  assert.equal(defaultHandoffStatus({ handoffStatus: 'BA Review', statusLabels: {} }), 'BA Review');
  assert.equal(defaultHandoffStatus({ statusLabels: { Done: 1 } }), null);
  assert.deepEqual(hookRuns(['x', '{itemId}', '{mr}'], { itemId: '1', mrs: [] }), []);
  assert.deepEqual(hookRuns(['x', '{itemId}', '{to}'], { itemId: '1', mrs: [], to: 'Sub' }), [['x', '1', 'Sub']]);
  assert.deepEqual(hookRuns(undefined, { mrs: ['u'] }), []);
});

test('isDoneStatus and htmlToText', () => {
  assert.equal(isDoneStatus('Deployed On Prod'), true);
  assert.equal(isDoneStatus('Ready For QA'), false);
  assert.equal(isDoneStatus('Shipped', ['Shipped']), true);
  assert.equal(htmlToText('<p>a&amp;b﻿</p><ul><li>x</li></ul>'), 'a&b\nx');
});

test('normalize: legacy role columns become aliases (with estimate), and survive as config', () => {
  const ref = normalize({ techStatusLabels: { main: {} }, boards: { main: { id: 5, columns: { techStatus: 'status', timeEstimateHrs: 'numeric_x' } } }, hooks: { handoff: ['a'] } });
  assert.deepEqual(ref.boards['5'].aliases, { estimate: 'numeric_x', techStatus: 'status', timeEstimateHrs: 'numeric_x' });
  assert.deepEqual(ref.hooks, { handoff: ['a'] });
});

test('replies: found through their item (--item or a post URL); replying to a reply threads under its update', async () => {
  const calls = [];
  const api = async (query, vars) => {
    calls.push({ query, vars });
    if (/updates\(ids/.test(query)) return { updates: vars.ids[0] === '9' ? [{ id: '9', item_id: '42', body: '<p>top</p>', text_body: 'top', creator: { name: 'Me' }, replies: [] }] : [] };
    if (/items\(ids/.test(query) && /replies/.test(query)) return { items: [{ name: 'Task', updates: [{ id: '9', replies: [{ id: '77', body: '<p>a reply</p>', text_body: 'a reply', creator: { name: 'Me' } }] }] }] };
    if (/create_update/.test(query)) return { create_update: { id: '555', creator: { name: 'Me' } } };
    throw new Error(`unexpected ${query}`);
  };
  setRuntime({ ref: REF, api });
  await assert.rejects(() => cmds['update-get'](['77']), /pass --item <itemId> or its post URL/);
  setRuntime({ ref: REF, api, flags: { item: '42' } });
  const r = await cmds['update-get'](['77']);
  assert.equal(r.parentId, '9');
  assert.equal(r.text, 'a reply');
  setRuntime({ ref: REF, api, flags: { 'dry-run': true } });
  const del = await cmds['update-delete'](['https://x.monday.com/boards/1/pulses/42/posts/77']);
  assert.equal(del.action, 'delete reply 77 on item 42');
  setRuntime({ ref: REF, api });
  const rep = await cmds.reply(['https://x.monday.com/boards/1/pulses/42/posts/77', '<p>answer</p>']);
  assert.equal(rep.parentUpdateId, '9');
  assert.equal(calls.find((c) => /create_update/.test(c.query)).vars.p, '9');
});

test('mine --by board --tasks: tasks grouped under their board, subitems named with their parent, sessions counted, no mentions fetched', async () => {
  const calls = [];
  const items = {
    100: [{ id: '1', name: 'Fix login', parent_item: null, column_values: [{ text: 'Dev In Progress' }] }, { id: '2', name: 'Old idea', parent_item: null, column_values: [{ text: 'Backlog' }] }, { id: '3', name: 'Shipped', parent_item: null, column_values: [{ text: 'Done' }] }],
    200: [{ id: '4', name: 'backend', parent_item: { name: 'Reports' }, column_values: [{ text: 'Ready For QA' }] }],
  };
  const api = async (query, vars) => {
    calls.push(query);
    if (/items_page/.test(query)) return { boards: [{ items_page: { cursor: null, items: items[vars.b[0]] } }] };
    throw new Error(`unexpected ${query}`);
  };
  const ref = { ...REF, boards: { ...REF.boards, 200: { id: 200, name: 'Subitems', statusColumn: 'status', assigneeColumn: 'person', columns: {}, statusLabels: {} } } };
  setRuntime({ ref, api, flags: { by: 'board', tasks: true } });
  const r = await cmds.mine([]);
  assert.deepEqual(r.open.map((it) => [it.board, it.name, it.status]), [['Board', 'Fix login', 'Dev In Progress'], ['Subitems', 'Reports > backend', 'Ready For QA']]);
  assert.equal(r.parked, 1); // Backlog is counted, not listed; Done never appears
  assert.equal(r.mentions, undefined);
  assert.ok(!calls.some((q) => /updates\(limit/.test(q)), 'mentions are not fetched with --tasks');
  setRuntime({ ref, api, flags: { by: 'board', tasks: true, status: 'ready for qa, Backlog' } });
  const picked = await cmds.mine([]);
  assert.deepEqual(picked.open.map((it) => it.name), ['Old idea', 'Reports > backend']); // only the asked labels, any case
  assert.equal(picked.parked, 0);
    setRuntime({ ref, api, flags: { by: 'nope' } });
  await assert.rejects(() => cmds.mine([]), /--by takes "status" or "board"/);
});

test('attach uploads each file to the update and dry-run sends nothing', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-attach-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.pdf');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'y');
  const uploads = [];
  const upload = async (id, f) => { uploads.push([id, path.basename(f)]); return { id: String(uploads.length), name: path.basename(f) }; };
  setRuntime({ ref: REF, api: fakeApi().api, upload, flags: { 'dry-run': true } });
  const dry = await cmds.attach(['9', a, b]);
  assert.equal(dry.dryRun, true);
  assert.equal(uploads.length, 0);
  setRuntime({ ref: REF, api: fakeApi().api, upload });
  const out = await cmds.attach(['9', a, b]);
  assert.deepEqual(uploads, [['9', 'a.png'], ['9', 'b.pdf']]);
  assert.deepEqual(out, { updateId: '9', assets: [{ id: '1', name: 'a.png' }, { id: '2', name: 'b.pdf' }] });
  await assert.rejects(cmds.attach(['9', path.join(dir, 'nope.png')]), /No such file/);
  fs.rmSync(dir, { recursive: true });
});

test('createClient upload posts multipart to /file and surfaces API errors', async () => {
  const { createClient } = require('../mon.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mon-up-')), 'shot.png');
  fs.writeFileSync(f, 'png');
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push({ url, query: opts.body.get('query'), file: opts.body.get('variables[file]') });
    return { status: 200, json: async () => ({ data: { add_file_to_update: { id: '77', name: 'shot.png' } } }) };
  };
  const { upload } = createClient({ endpoint: 'https://api.monday.com/v2', apiVersion: '2026-04', token: 't', fetch });
  assert.deepEqual(await upload('123', f), { id: '77', name: 'shot.png' });
  assert.equal(seen[0].url, 'https://api.monday.com/v2/file');
  assert.match(seen[0].query, /add_file_to_update\(update_id: 123, file: \$file\)/);
  assert.equal(seen[0].file.name, 'shot.png');
  await assert.rejects(upload('12; drop', f), /Not an update id/);
  const bad = createClient({ endpoint: 'e', apiVersion: 'v', token: 't', fetch: async () => ({ status: 200, json: async () => ({ errors: [{ message: 'nope' }] }) }) });
  await assert.rejects(bad.upload('1', f), /nope/);
});

test('like and unlike send the mutation for the id, and dry-run sends nothing', async () => {
  const f = fakeApi();
  const api = async (q, v) => { f.calls.push({ query: q, vars: v }); return {}; };
  setRuntime({ ref: REF, api, flags: { 'dry-run': true } });
  assert.equal((await cmds.like(['42'])).dryRun, true);
  assert.equal(f.calls.length, 0);
  setRuntime({ ref: REF, api });
  assert.deepEqual(await cmds.like(['42']), { liked: '42' });
  assert.deepEqual(await cmds.unlike(['42']), { unliked: '42' });
  assert.match(f.calls[0].query, /like_update\(update_id:\$id\)/);
  assert.match(f.calls[1].query, /unlike_update\(update_id:\$id\)/);
  assert.deepEqual(f.calls.map((c) => c.vars.id), ['42', '42']);
  await assert.rejects(cmds.like(['x']), /Usage/);
});
