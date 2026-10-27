const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { itemIdsIn, mrUrlsIn, mrRepo } = require('../lib/links');
const { createsMr, commandDir, commandSourceBranch, isAutomated, readTranscript } = require('../lib/transcripts');

let hasSqlite = true;
try { require('node:sqlite'); } catch { hasSqlite = false; }
const sqlite = { skip: hasSqlite ? false : 'node:sqlite needs Node 22.13+' };
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'links-')), 'links.db');
const open = () => require('../lib/links').openLinks(tmpDb());
const MR = 'https://git.example/team/backend/-/merge_requests/452';
const MR2 = 'https://git.example/team/ui/-/merge_requests/286';
const noHost = { info: null };

test('itemIdsIn / mrUrlsIn / mrRepo read ids and links from free text', () => {
  assert.deepEqual(itemIdsIn('see https://x.monday.com/boards/1/pulses/10000000001 and monday_10000000002, monday item 10000000003'), ['10000000001', '10000000002', '10000000003']);
  assert.deepEqual(itemIdsIn('board 20000000001 on 2026-10-16'), []);
  assert.deepEqual(mrUrlsIn(`MRs ${MR}, and https://github.com/o/r/pull/7)`), [MR, 'https://github.com/o/r/pull/7']);
  assert.equal(mrRepo(MR), 'backend');
  assert.equal(mrRepo('https://github.com/o/r/pull/7'), 'r');
});

test('createsMr: only a segment that runs glab/gh create counts, not a quoted mention', () => {
  assert.equal(createsMr('cd /w && git push --force-with-lease && glab mr create --title x'), true);
  assert.equal(createsMr('GH_HOST=x gh pr create --fill'), true);
  assert.equal(createsMr('glab api projects/1/merge_requests -X POST -f title=x'), true);
  assert.equal(createsMr('printf \'{"command":"glab mr create"}\' | node hook.js'), false);
  assert.equal(createsMr('grep -rn "glab mr create" .'), false);
  assert.equal(createsMr('glab mr view 452'), false);
});

test('commandDir / commandSourceBranch / isAutomated', () => {
  assert.equal(commandDir('cd /w/backend/fix && glab mr create', '/start'), '/w/backend/fix');
  assert.equal(commandDir('git -C "/w/ui" push', '/start'), '/w/ui');
  assert.equal(commandDir('glab mr create', '/start'), '/start');
  assert.equal(commandSourceBranch('glab mr create -s fix/a --title t'), 'fix/a');
  assert.equal(commandSourceBranch('gh pr create --head feat/b'), 'feat/b');
  assert.equal(commandSourceBranch('glab mr create --title t'), null);
  assert.equal(isAutomated('/w/backend/_mr-rebase-bot'), true);
  assert.equal(isAutomated('/Users/me/Dev/mr-rebase-bot'), false); // working ON the bot is real work
});

test('readTranscript: title, prompts, edits and MRs it created (create call + its result)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), 'abc.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-14T10:00:00Z', cwd: '/w', gitBranch: 'master', message: { content: 'work on pulses/10000000001' } },
    { type: 'assistant', timestamp: '2026-10-14T10:01:00Z', cwd: '/w', gitBranch: 'master', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd /w/fix && glab mr create --title x' } }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/fix/a.php' } }] } },
    { type: 'user', timestamp: '2026-10-14T10:02:00Z', cwd: '/w', gitBranch: 'master', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `Creating...\n${MR}\n` }] } },
    { type: 'custom-title', customTitle: 'monday_10000000001' },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  const f = readTranscript(file);
  assert.equal(f.session, 'abc');
  assert.equal(f.title, 'monday_10000000001');
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.edits.map((e) => e.file), ['/w/fix/a.php']);
  assert.equal(f.createdMrs.length, 1);
  assert.match(f.createdMrs[0].output, /merge_requests\/452/);
  assert.equal(f.branchEvents.get('/w\u0000master'), 3);
});

test('links: an MR created in a session joins that session\'s task, and resolves from any side', sqlite, () => {
  const s = open();
  s.touchSession({ id: 'A', cwd: '/w', at: '2026-10-14T10:00:00Z' });
  s.linkTaskSession('10000000001', 'A', 'prompt', '2026-10-14T10:00:00Z');
  s.touchBranch({ session: 'A', repo: 'backend', branch: 'fix/x', events: 5 });
  s.recordCreatedMr({ session: 'A', url: MR, repo: 'backend', branch: 'fix/x', commandText: 'glab mr create', ...noHost });
  s.touchBranch({ session: 'B', repo: 'backend', branch: 'fix/x', events: 2 });
  s.touchSession({ id: 'C' });
  s.setTitle('C', 'monday_10000000001');
  const byItem = s.resolve({ item: '10000000001' });
  assert.deepEqual(byItem.mrs.map((m) => [m.url, m.branch]), [[MR, 'fix/x']]);
  assert.deepEqual(byItem.sessions.map((x) => x.id), ['A', 'B', 'C']); // branch work outranks a name
  assert.deepEqual(byItem.sessions[0].how, ['created the MR', 'worked on the MR branch', 'named the task in a prompt']);
  assert.deepEqual(s.resolve({ mr: MR }).sessions.map((x) => x.id), ['A', 'B', 'C']);
  assert.deepEqual(s.resolve({ session: 'C' }).items, ['10000000001']);
  assert.deepEqual(s.resolve({ branch: 'fix/x', repo: 'backend' }).items, ['10000000001']);
  s.close();
});

test('links: the MR description\'s task link beats the session\'s guess; the earliest creation sets the branch', sqlite, () => {
  const s = open();
  s.linkTaskSession('10000000001', 'A', 'prompt');
  s.recordCreatedMr({ session: 'A', url: MR, repo: 'backend', branch: 'fix/x', at: '2026-10-14T10:00:00Z', info: { branch: 'fix/real', description: 'https://x.monday.com/boards/1/pulses/10000000002\n\nSummary' } });
  assert.deepEqual(s.resolve({ mr: MR }).items, ['10000000002']);
  assert.equal(s.resolve({ mr: MR }).mrs[0].branch, 'fix/real');
  s.recordCreatedMr({ session: 'Z', url: MR2, repo: 'ui', branch: 'later/guess', at: '2026-10-16T10:00:00Z', ...noHost });
  s.recordCreatedMr({ session: 'Y', url: MR2, repo: 'ui', branch: 'fix/first', at: '2026-10-14T10:00:00Z', ...noHost });
  s.recordCreatedMr({ session: 'X', url: MR2, repo: 'ui', branch: 'later/again', at: '2026-10-17T10:00:00Z', ...noHost });
  assert.equal(s.resolve({ mr: MR2 }).mrs[0].branch, 'fix/first');
  s.close();
});

test('links: a later title or hand link upgrades a prompt mention; re-imports don\'t inflate branch counts', sqlite, () => {
  const s = open();
  s.linkTaskSession('10000000001', 'A', 'prompt');
  s.linkTaskSession('10000000001', 'A', 'title');
  s.linkTaskSession('10000000001', 'A', 'prompt');
  assert.equal(s.db.prepare('SELECT source FROM task_sessions').get().source, 'title');
  s.touchBranch({ session: 'A', repo: 'r', branch: 'b', events: 7, replace: true });
  s.touchBranch({ session: 'A', repo: 'r', branch: 'b', events: 7, replace: true });
  s.touchBranch({ session: 'A', repo: 'r', branch: 'b', events: 1 });
  assert.equal(s.db.prepare('SELECT events FROM session_branches').get().events, 8);
  s.close();
});

test('links: itemsBySession joins prompts, task branches and MR branches (for time accounting)', sqlite, () => {
  const s = open();
  s.linkTaskSession('10000000001', 'A', 'prompt');
  s.linkTaskBranch('10000000002', 'backend', 'fix/y', 'manual');
  s.touchBranch({ session: 'B', repo: 'backend', branch: 'fix/y' });
  s.recordCreatedMr({ session: 'A', url: MR, repo: 'backend', branch: 'fix/x', ...noHost });
  s.touchBranch({ session: 'C', repo: 'backend', branch: 'fix/x' });
  const m = s.itemsBySession();
  assert.deepEqual(m.get('A'), ['10000000001']);
  assert.deepEqual(m.get('B'), ['10000000002']);
  assert.deepEqual(m.get('C'), ['10000000001']);
  s.close();
});

test('links-hook: records a prompt, an edit in a worktree and a created MR; skips bot sessions', sqlite, () => {
  const db = tmpDb();
  const hook = (payload) => execFileSync('node', [path.join(__dirname, '..', 'hooks', 'links-hook.js')], { input: JSON.stringify(payload), env: { ...process.env, MONDAY_LINKS_DB: db, MR_REBASE_BOT: '' } });
  hook({ session_id: 'S', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt: 'monday item 10000000001 please' });
  hook({ session_id: 'S', cwd: '/tmp', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'glab mr create -s fix/z --title t' }, tool_response: { stdout: `${MR}\n` } });
  hook({ session_id: 'BOT', cwd: '/w/backend/_mr-rebase-bot', hook_event_name: 'UserPromptSubmit', prompt: 'monday_10000000001' });
  const s = require('../lib/links').openLinks(db);
  const r = s.resolve({ item: '10000000001' });
  assert.deepEqual(r.sessions.map((x) => x.id), ['S']);
  assert.deepEqual(r.mrs.map((m) => m.url), [MR]);
  s.close();
});

test('review fixes: URL paths with @ are not mentions; URLs split at escaped newlines; MR notes are not creations', () => {
  const { expandMentions } = require('../lib/post');
  const { html, mentioned } = expandMentions('<p>see https://medium.com/@someone/post and mailto:@x</p>', { A: '1' }, () => { throw new Error('should not resolve'); });
  assert.equal(mentioned.length, 0);
  assert.match(html, /medium\.com\/@someone/);
  assert.deepEqual(mrUrlsIn(JSON.stringify({ stdout: `https://x.y/z\n${MR}` })), [MR]);
  assert.equal(createsMr('glab api -X POST projects/1/merge_requests/5/notes -f body=x'), false);
  assert.equal(createsMr('glab api -X POST projects/1/merge_requests -f title=x'), true);
});

test('MR description: only its first task link counts', sqlite, () => {
  const s = open();
  s.recordCreatedMr({ session: 'A', url: MR, repo: 'backend', branch: 'fix/x', info: { branch: 'fix/x', description: 'https://x.monday.com/boards/1/pulses/10000000005\n\nSee also https://x.monday.com/boards/1/pulses/10000000006' } });
  assert.deepEqual(s.resolve({ mr: MR }).items, ['10000000005']);
  s.close();
});

test('links-hook on SessionStart names an untitled one-task session monday_<id>, and nothing else', sqlite, () => {
  const db = tmpDb();
  const hook = (payload, env = {}) => execFileSync('node', [path.join(__dirname, '..', 'hooks', 'links-hook.js')], { input: JSON.stringify(payload), env: { ...process.env, MONDAY_LINKS_DB: db, MR_REBASE_BOT: '', ...env } }).toString();
  hook({ session_id: 'ONE', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt: 'monday_10000000001' });
  hook({ session_id: 'TWO', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt: 'pulses/10000000001 and pulses/10000000002' });
  const start = (session, extra = {}) => hook({ session_id: session, cwd: '/tmp', hook_event_name: 'SessionStart', source: 'resume', ...extra });
  assert.deepEqual(JSON.parse(start('ONE')), { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'monday_10000000001' } });
  assert.equal(start('ONE', { session_title: 'my name' }), ''); // never overwrite a name you chose
  const store = require('../lib/links').openLinks(db);
  store.touchSession({ id: 'NAMED' });
  store.linkTaskSession('10000000001', 'NAMED', 'prompt');
  store.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('meta_username', 'NAMED');
  store.close();
  assert.equal(start('NAMED'), ''); // a title already known from the transcript is kept too
  assert.equal(start('TWO'), ''); // two tasks: ambiguous
  assert.equal(start('NEW', { source: 'startup' }), ''); // nothing known yet
  assert.equal(start('ONE', { source: 'compact' }), '');
  assert.equal(hook({ session_id: 'ONE', cwd: '/tmp', hook_event_name: 'SessionStart', source: 'resume' }, { MONDAY_LINKS_AUTONAME: '0' }), '');
  assert.equal(hook({ session_id: 'ONE', cwd: '/tmp', hook_event_name: 'Stop' }), ''); // other events stay silent
});

test('resume --print: the best session from its own directory, else a new named one', sqlite, () => {
  const db = tmpDb();
  const s = require('../lib/links').openLinks(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'));
  const transcript = path.join(dir, 'S1.jsonl');
  fs.writeFileSync(transcript, '{}');
  s.touchSession({ id: 'S1', transcript, cwd: dir });
  s.linkTaskSession('10000000001', 'S1', 'title');
  s.close();
  const run = (id) => JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'mon.js'), 'resume', id, '--print', '--json'], { env: { ...process.env, MONDAY_LINKS_DB: db, MONDAY_CLAUDE_CONFIG: path.join(dir, 'ref.json'), monday_api_key: '' } }).toString());
  assert.equal(run('10000000001').command, `cd ${JSON.stringify(dir)} && claude --resume S1`);
  assert.match(run('10000000009').command, /claude --name monday_10000000009$/);
});

test('an MR whose description the host returned without a task link has no task; the repo comes from its URL', sqlite, () => {
  const s = open();
  s.linkTaskSession('10000000001', 'A', 'prompt');
  s.recordCreatedMr({ session: 'A', url: MR, repo: 'wrong-cwd-repo', branch: 'feat/x', info: { branch: 'feat/x', description: '## Why\n\nno task here' } });
  assert.deepEqual(s.resolve({ mr: MR }).items, []);
  assert.deepEqual(s.resolve({ mr: MR }).mrs, [{ url: MR, repo: 'backend', branch: 'feat/x' }]);
  assert.deepEqual(s.resolve({ item: '10000000001' }).mrs, []);
  s.recordCreatedMr({ session: 'A', url: MR2, repo: 'ui', branch: 'fix/y', info: null }); // host unreachable: fall back to the session's task
  assert.deepEqual(s.resolve({ mr: MR2 }).items, ['10000000001']);
  s.close();
});
