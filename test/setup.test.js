const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasLinksHook, withLinksHook, writeSettings, readSettings } = require('../lib/claude-settings');
const { pickBoards } = require('../mon.js');

test('withLinksHook adds the hook to each event, keeps everything else, and is idempotent', () => {
  const before = { theme: 'dark', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'afplay x.aiff' }] }] } };
  const after = withLinksHook(before, '/opt/monday-claude/hooks/links-hook.js');
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'afplay x.aiff');
  assert.equal(after.hooks.PostToolUse[0].matcher, 'Edit|Write|NotebookEdit|Bash');
  assert.deepEqual(after.hooks.UserPromptSubmit[0].hooks[0], { type: 'command', command: 'node "/opt/monday-claude/hooks/links-hook.js"', async: true, timeout: 10 });
  assert.equal(hasLinksHook(before), false);
  assert.equal(hasLinksHook(after), true);
  assert.deepEqual(withLinksHook(after, '/elsewhere/hooks/links-hook.js'), after); // a moved clone isn't added twice
  assert.deepEqual(before.hooks.Stop.length, 1); // input not mutated
});

test('writeSettings keeps a .bak and leaves valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  writeSettings(file, { a: 2 });
  assert.deepEqual(readSettings(file), { a: 2 });
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.bak']);
});

test('pickBoards: list numbers and ids, mixed; anything else is an error', () => {
  const boards = [{ id: 11, name: 'A' }, { id: 22, name: 'B' }, { id: 33, name: 'C' }];
  assert.deepEqual(pickBoards('1, 3', boards), ['11', '33']);
  assert.deepEqual(pickBoards('22 1', boards), ['22', '11']);
  assert.deepEqual(pickBoards('', boards), []);
  assert.throws(() => pickBoards('9', boards), /neither a number from the list nor a board id/);
});

test('SessionStart gets the hook synchronously (its output names the session); other events async', () => {
  const after = withLinksHook({}, '/x/hooks/links-hook.js');
  assert.deepEqual(after.hooks.SessionStart[0].hooks[0], { type: 'command', command: 'node "/x/hooks/links-hook.js"', timeout: 5 });
  assert.equal(after.hooks.Stop[0].hooks[0].async, true);
  const old = { hooks: Object.fromEntries(['UserPromptSubmit', 'Stop', 'PostToolUse'].map((e) => [e, [{ hooks: [{ command: 'node "/x/hooks/links-hook.js"' }] }]])) };
  assert.equal(hasLinksHook(old), false); // an install from before SessionStart naming gets it added
  assert.equal(withLinksHook(old, '/x/hooks/links-hook.js').hooks.SessionStart.length, 1);
});
