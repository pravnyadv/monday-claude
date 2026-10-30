#!/usr/bin/env node
/**
 * mon.js — a small monday.com helper CLI, account-agnostic.
 *
 * Setup (one time):
 *   node mon.js login                   # paste your monday API token; saved for next time
 *   node mon.js init                    # list your boards
 *   node mon.js init <boardId> [more]   # configure boards (auto-detects status + people columns)
 *
 * Then:  node mon.js <command> [args] [--json]
 *
 * Commands:
 *   setup [--boards id,id] [--yes]       First run: asks for your token (hidden) and the boards to track,
 *                                        registers the session-links hook, and backfills links.
 *   login [token]                        Save your monday API token (prompts, hidden, if omitted); verified before saving.
 *   logout                               Remove the saved token.
 *   init [boardId...]                    No args: list your boards. With ids: configure them.
 *   refresh                              Re-fetch status labels + people for configured boards.
 *   whoami                               Show the authenticated user.
 *   people [name]                        Look up people ids (all, or names containing <name>).
 *   labels [boardId]                     List valid status labels (all configured boards, or one).
 *
 *   list <boardId>                       List items on a board (id, name, status).
 *   search <boardId> "<text>"            List items on a board whose name contains <text>.
 *   get <itemId> [--full] [--updates N]  Name, board, group, column values. --full adds column ids/types,
 *                                        the description and the last 5 updates (or N) with replies.
 *   mine [--by status|board] [--status "A,B"] [--tasks] [--days N] [--all]
 *                                        My open items, grouped by status (default) or board, each marked with
 *                                        how many Claude sessions it has; Backlog/Pause only counted unless
 *                                        --all; --status keeps only those labels (case-insensitive). Then
 *                                        updates mentioning me I haven't answered (14 days);
 *                                        --tasks skips those.
 *   updates <itemId> [--limit N] [--images <dir>]   The latest N (20) updates with replies, oldest first.
 *   update-get <updateId|postUrl>        One update or reply: author, item, text, replies, image asset ids.
 *                                        A reply needs --item <itemId> or its post URL (monday can't look one up alone).
 *   update-images <updateId> [outDir]    Download every image/asset attached to an update (default: cwd).
 *   desc-get <itemId>                    Print the item description as markdown.
 *   desc-images <itemId> [outDir]        Download every image embedded in the description (default: cwd).
 *   activity <itemId> [--days N]         Who changed what on an item (last 30 days by default).
 *
 *   status <itemId> "<label>"            Set the board's status column (validates the label).
 *   assign <itemId> <name|id> [more...]  Set assignee(s) (resolves names via reference.json people).
 *   set <itemId> "<column>" <value...>   Set any column by id, alias or title (numbers, text, date,
 *                                        timeline a..b, status, people, dropdown, link, ...). "" clears.
 *   estimate <itemId> <hours>            Set the board's estimate column.
 *   update <itemId> "<html>|@file|-" [--cc A,B]   Post an update (see "Posting" below).
 *   comment <itemId> "<html>|@file|-"    Same as update.
 *   reply <updateId> "<html>|@file|-" [--cc A,B]  Post a threaded reply UNDER an existing update.
 *   update-edit <updateId> "<html>|@file|-"       Replace an update's body in place (mentions must not change).
 *   update-delete <updateId>             Delete one update (you must be its author).
 *   attach <updateId> <file> [more...]   Attach local files to an update or reply (images show inline).
 *   like <updateId> / unlike <updateId>  Like or unlike an update or reply.
 *   desc-set <itemId> <file.md>          Replace the item description from a markdown file.
 *   handoff <itemId> --to <Name> [--status "<label>"] [--mr <url>]... [--body "<html>|@file"]
 *           [--cc A,B] [--estimate <hours>] [--keep-assignees]
 *                                        Post the handoff update (greets --to, links each MR), set the
 *                                        status (default: the board's "Ready For QA"-like label), set the
 *                                        estimate, assign --to, run the configured handoff hook, read back.
 *
 *   insights <boardId> [--by "<column>"] Item counts grouped by a column (default: status).
 *   automations <boardId>                The board's automations and whether each is active.
 *   meetings ["<query>"] [--since D] [--until D] [--limit N]   Find notetaker meetings.
 *   meetings --id <meetingId> [--transcript]                   One meeting's summary and action items.
 *   links <itemId|mrUrl> | --session <id> | --branch <b> [--repo r]
 *                                        The task's monday items, MRs and Claude sessions (best match first,
 *                                        with a resume command). Kept by hooks/links-hook.js; local only.
 *   links add <itemId> [--mr <url>]... [--session <id>] [--branch <b> --repo <r>]   Link by hand.
 *   links import [--days N]              Backfill from Claude transcripts (default 180 days).
 *   resume <itemId> [--new] [--url u] [--print]   Reopen the task's best Claude session (from its own directory), or
 *                                        start a new one named monday_<id>. --print just prints the command.
 *   mcp tools [filter]                   List the hosted monday MCP tools (RO = read-only).
 *   mcp <tool> ['<json>'|@file] [--write]  Call any MCP tool; write tools need --write.
 *   help                                 Show this list.
 *
 * Every write takes --dry-run: it prints exactly what would be sent (final HTML, resolved mentions,
 * validated label, resolved ids) and changes nothing. `--json` on any command prints a machine-readable
 * result. Token source (first found wins): the monday_api_key env var, then the file saved by `login`.
 * A body arg may be inline text, `@path` to read a file, or `-` for stdin.
 *
 * Posting (update, comment, reply, update-edit, handoff): write `@First` or `@{Full Name}` and it becomes
 * a real mention; `--cc A,B` adds a last "CC:" line; whitespace between tags is removed (monday shows
 * each newline as a blank line); and the post is refused if its text has em/en dashes, arrow glyphs,
 * bullet/middle dots or curly quotes (override with --allow-style). Write `\@` for a literal @.
 *
 * The token acts AS the user it belongs to: every write is that user speaking.
 * reference.json (board/column ids, status labels, people->id map) is generated by `init`/`refresh`.
 * It lives next to this script if a reference.json is already there (existing setups), otherwise in
 * $XDG_CONFIG_HOME/monday-claude/ (default ~/.config/monday-claude/) so a plugin update can't wipe it.
 * Override the location with the MONDAY_CLAUDE_CONFIG env var.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { composePost, mentionIds, nameOf, anchor } = require('./lib/post');
const { findColumn, findEstimateColumn, columnValue, statusLabelsOf } = require('./lib/columns');
const { createMcpClient, isReadOnlyTool, NEVER_PASSTHROUGH } = require('./lib/mcp');
const { refPath, linksDbPath } = require('./lib/paths');

const DEFAULTS = { endpoint: 'https://api.monday.com/v2', apiVersion: '2026-04', tokenEnvVar: 'monday_api_key' };
const MAX_RETRIES = 4;

// ---- config file location -------------------------------------------------

/** Write a file atomically: write a sibling temp file, then rename over the target (atomic on the
 *  same filesystem), so a crash mid-write can't leave a truncated config or token. */
function writeFileAtomic(p, data, opts = {}) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, opts);
  fs.renameSync(tmp, p);
}

/** The saved-token file, kept next to reference.json (chmod 600, gitignored). */
function tokenPath() {
  return path.join(path.dirname(refPath()), 'monday-token');
}

/** The token to use: the env var if set, else the one saved by `login`, else null. Pure. */
function resolveToken({ env, saved }) {
  return (env && env.trim()) || (saved && saved.trim()) || null;
}

function readSavedToken() {
  try { return fs.readFileSync(tokenPath(), 'utf8').trim() || null; } catch { return null; }
}

function saveToken(token) {
  const p = tokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, token.trim() + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort on platforms without chmod */ }
  return p;
}

/** Read one secret line: hidden keystrokes on a TTY, else the first line of piped stdin. */
function readSecret(promptText) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0].trim()));
      stdin.on('error', reject);
    });
  }
  stdout.write(promptText);
  const rl = require('readline').createInterface({ input: stdin, output: stdout, terminal: true });
  rl._writeToOutput = () => {}; // suppress echo of the token
  return new Promise((resolve) => rl.question('', (answer) => { rl.close(); stdout.write('\n'); resolve(answer.trim()); }));
}

/** Ask one question on the terminal; '' when stdin isn't a terminal (callers fall back to flags). */
function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/**
 * Queue text as if typed on this terminal (TIOCSTI, echo off), so the next program reads it unsent.
 * Must run before claude starts: its TUI drops input injected once it's up. Node has no ioctl, hence python.
 */
function typeAhead(text) {
  const py = [
    'import fcntl, sys, termios',
    'old = termios.tcgetattr(0); new = termios.tcgetattr(0); new[3] &= ~termios.ECHO',
    'termios.tcsetattr(0, termios.TCSANOW, new)',
    'try:',
    '    for b in sys.argv[1].encode(): fcntl.ioctl(0, termios.TIOCSTI, bytes([b]))',
    'finally:',
    '    termios.tcsetattr(0, termios.TCSANOW, old)',
  ].join('\n');
  const r = require('child_process').spawnSync('python3', ['-I', '-c', py, text], { stdio: 'inherit' });
  if (r.status !== 0) log(`(couldn't pre-type the task link; paste it: ${text.trim()})`);
}

/** Pick boards from a numbered list: "1,3", ids, or a mix. Pure. */
function pickBoards(answer, boards) {
  return String(answer || '').split(/[\s,]+/).filter(Boolean).map((tok) => {
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= boards.length) return String(boards[n - 1].id);
    const hit = boards.find((b) => String(b.id) === tok);
    if (!hit) throw new Error(`"${tok}" is neither a number from the list nor a board id`);
    return String(hit.id);
  });
}

/**
 * Resolve a body argument (an update/reply/comment/description) to its text:
 *   `-`        read all of stdin (pipe the body in)
 *   `@path`    read that file, explicitly
 *   <path>     a bare path to an existing file is read (convenience), but only when the arg
 *              doesn't look like content itself (no `<` or newline), so inline HTML is never
 *              mistaken for a filename
 *   otherwise  the literal string
 */
function resolveBody(arg) {
  if (arg === '-') return fs.readFileSync(0, 'utf8');
  if (typeof arg === 'string' && arg.startsWith('@')) return fs.readFileSync(arg.slice(1), 'utf8');
  if (typeof arg === 'string' && !arg.includes('<') && !arg.includes('\n') && arg.length < 4096 && fs.existsSync(arg)) {
    return fs.readFileSync(arg, 'utf8');
  }
  return arg;
}

/** Read reference.json if present, else a bootstrap skeleton (so `init` can run before config exists). */
function loadRaw() {
  const p = refPath();
  const raw = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  return { ...DEFAULTS, ...raw };
}

function writeRef(ref) {
  const p = refPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const out = {
    endpoint: ref.endpoint,
    apiVersion: ref.apiVersion,
    tokenEnvVar: ref.tokenEnvVar,
    self: ref.self,
    ...(ref.hooks ? { hooks: ref.hooks } : {}),
    ...(ref.doneStatuses ? { doneStatuses: ref.doneStatuses } : {}),
    boards: ref.boards,
    people: ref.people,
  };
  writeFileAtomic(p, JSON.stringify(out, null, 2) + '\n');
  return p;
}

// ---- config normalization -------------------------------------------------

/**
 * Normalize both config shapes to one canonical in-memory form:
 *   boards: { "<boardId>": { id, name, statusColumn, assigneeColumn, columns:{id:{title,type}}, statusLabels:{label:idx} } }
 * The legacy shape (boards keyed by role name + top-level techStatusLabels) is adapted here so an
 * older reference.json keeps working unchanged.
 */
function normalize(raw) {
  const ref = {
    endpoint: raw.endpoint || DEFAULTS.endpoint,
    apiVersion: raw.apiVersion || DEFAULTS.apiVersion,
    tokenEnvVar: raw.tokenEnvVar || DEFAULTS.tokenEnvVar,
    self: raw.self || null,
    hooks: raw.hooks || null,
    doneStatuses: raw.doneStatuses || null,
    people: raw.people || {},
    boards: {},
  };
  const isLegacy = !!raw.techStatusLabels;
  for (const [key, b] of Object.entries(raw.boards || {})) {
    if (!b || !b.id) continue;
    const idStr = String(b.id);
    if (isLegacy) {
      ref.boards[idStr] = {
        id: Number(b.id),
        name: b.name,
        statusColumn: b.columns && b.columns.techStatus,
        assigneeColumn: b.columns && b.columns.assignee,
        columns: {},
        statusLabels: (raw.techStatusLabels && raw.techStatusLabels[key]) || {},
        // The legacy role names (timeEstimateHrs, dueDate, ...) stay usable as column aliases.
        aliases: { ...(b.columns?.timeEstimateHrs ? { estimate: b.columns.timeEstimateHrs } : {}), ...(b.columns || {}), ...(b.aliases || {}) },
      };
    } else {
      ref.boards[idStr] = {
        id: Number(b.id),
        name: b.name,
        statusColumn: b.statusColumn,
        assigneeColumn: b.assigneeColumn,
        columns: b.columns || {},
        statusLabels: b.statusLabels || {},
        aliases: b.aliases || {},
        ...(b.handoffStatus ? { handoffStatus: b.handoffStatus } : {}),
      };
    }
  }
  return ref;
}

// ---- HTTP client (retry + backoff, injectable fetch) ----------------------

/** Backoff for retry `attempt` (0-based); honors a Retry-After header (seconds) when present. */
function nextDelay(attempt, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 30000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A monday GraphQL client. `fetch`/`sleep` are injectable for tests. Retries on 429, 5xx, network
 * errors, and monday's complexity/rate-limit errors (which arrive as 200 + `errors`).
 */
function createClient({ endpoint, apiVersion, token, fetch: fetchImpl = globalThis.fetch, sleepFn = sleep, maxRetries = MAX_RETRIES } = {}) {
  async function api(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': apiVersion },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        if (attempt < maxRetries) { await sleepFn(nextDelay(attempt)); continue; }
        throw new Error(`network error contacting monday: ${e.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleepFn(nextDelay(attempt, res.headers?.get?.('retry-after')));
        continue;
      }
      let json;
      try { json = await res.json(); }
      catch { throw new Error(`monday returned a non-JSON response (HTTP ${res.status})`); }
      if (json.errors) {
        const msg = json.errors.map((e) => e.message).join('; ');
        if (attempt < maxRetries && /complexity|rate limit/i.test(msg)) { await sleepFn(nextDelay(attempt)); continue; }
        throw new Error('Monday API error: ' + msg);
      }
      return json.data;
    }
  }
  /** Attach one local file to an update or reply (multipart to <endpoint>/file). Only a 429 is retried:
   *  the upload may have landed before any other failure. */
  async function upload(updateId, filePath) {
    if (!/^\d+$/.test(String(updateId))) throw new Error(`Not an update id: ${updateId}`);
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append('query', `mutation($file: File!){ add_file_to_update(update_id: ${updateId}, file: $file){ id name } }`);
      form.append('variables[file]', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
      const res = await fetchImpl(`${endpoint}/file`, { method: 'POST', headers: { Authorization: token, 'API-Version': apiVersion }, body: form });
      if (res.status === 429 && attempt < maxRetries) { await sleepFn(nextDelay(attempt, res.headers?.get?.('retry-after'))); continue; }
      let json;
      try { json = await res.json(); }
      catch { throw new Error(`monday returned a non-JSON response to the upload (HTTP ${res.status})`); }
      if (json.errors || json.error_message) throw new Error('Monday API error: ' + (json.errors ? json.errors.map((e) => e.message).join('; ') : json.error_message));
      return json.data.add_file_to_update;
    }
  }
  return { api, upload };
}

// ---- pure helpers (unit-tested) -------------------------------------------

const STATUS_TYPES = new Set(['status', 'color']);
const PEOPLE_TYPES = new Set(['people', 'person', 'multiple-person']);

/** Pick a column id by type from a list of {id,type}, preferring an exact `preferred` type. */
function detectColumn(columns, types, preferred) {
  const matches = columns.filter((c) => types.has(c.type));
  const exact = matches.find((c) => c.type === preferred);
  return (exact || matches[0] || {}).id || null;
}

/** Parse a status column's settings_str into { label: index }, dropping deactivated labels. */
function labelsFromSettings(settingsStr) {
  const s = JSON.parse(settingsStr || '{}');
  const dead = new Set(s.deactivated_labels || []);
  const out = {};
  Object.entries(s.labels || {}).forEach(([idx, name]) => {
    if (name && !dead.has(Number(idx))) out[name] = Number(idx);
  });
  return out;
}

/** Resolve a person to a Monday user id: numeric id passes through; else exact name, else unique prefix. */
function resolvePerson(people, nameOrId) {
  if (/^\d+$/.test(nameOrId)) return nameOrId;
  const lc = nameOrId.toLowerCase();
  const entries = Object.entries(people).filter(([n]) => n[0] !== '_');
  const exact = entries.find(([n]) => n.toLowerCase() === lc);
  if (exact) return exact[1];
  const prefix = entries.filter(([n]) => n.toLowerCase().startsWith(lc));
  if (prefix.length === 1) return prefix[0][1];
  if (prefix.length > 1) {
    throw new Error(`Ambiguous person "${nameOrId}": ${prefix.map(([n]) => n).join(', ')}. Use a fuller name or the numeric id.`);
  }
  throw new Error(`Unknown person "${nameOrId}". Run  mon.js refresh  to re-sync people, then retry. Known: ${entries.map(([n]) => n).join(', ')}`);
}

/** column_values JSON for a status label. */
function statusColumnValues(col, label) {
  return JSON.stringify({ [col]: { label } });
}

/** column_values JSON for one or more assignees (already-resolved numeric ids). */
function assigneeColumnValues(col, ids) {
  return JSON.stringify({ [col]: { personsAndTeams: ids.map((id) => ({ id: Number(id), kind: 'person' })) } });
}

function blocksToMarkdown(blocks) {
  return (blocks || []).map((b) => {
    let c;
    try { c = JSON.parse(b.content); } catch { return b.content || ''; }
    if (b.type === 'image') {
      const name = (c.url || '').split('/').pop() || 'image';
      return `![${name}](assetId:${c.assetId})`;
    }
    const text = (c.deltaFormat || []).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('');
    if (b.type === 'bulleted list') return '- ' + text;
    if (b.type === 'numbered list') return '1. ' + text;
    return text;
  }).join('\n');
}

const BOOL_FLAGS = new Set(['json', 'dry-run', 'allow-style', 'full', 'write', 'keep-assignees', 'transcript', 'all', 'yes', 'no-hooks', 'no-names', 'print', 'tasks', 'new']);
const VALUE_FLAGS = new Set(['boards', 'cc', 'to', 'status', 'mr', 'body', 'estimate', 'by', 'days', 'limit', 'images', 'id', 'since', 'until', 'updates', 'item', 'session', 'branch', 'repo', 'url']);
const LIST_FLAGS = new Set(['cc', 'mr']);

/** Split argv into positional args and --flags; list flags repeat or take commas. Unknown flags throw. */
function parseArgs(argv) {
  const positional = [];
  const flags = { cc: [], mr: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { positional.push(a); continue; }
    const [, name, inline] = m;
    if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag --${name}. Try:  mon.js help`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (LIST_FLAGS.has(name)) flags[name].push(...value.split(',').map((v) => v.trim()).filter(Boolean));
    else flags[name] = value;
  }
  return { positional, flags };
}

const DEFAULT_DONE = /^(done|deployed|obsolete|closed|complete|cancel|released|live|won't)/i;
const DEFAULT_PARKED = /^(backlog|pause|on hold|parked|later|someday)/i;

/** Open but not being worked on: listed by `mine` only as a count unless --all. */
const isParkedStatus = (label) => DEFAULT_PARKED.test(label || '');

/** Whether a status label counts as finished (configurable with "doneStatuses" in reference.json). */
function isDoneStatus(label, doneStatuses) {
  if (!label) return false;
  return doneStatuses ? doneStatuses.includes(label) : DEFAULT_DONE.test(label);
}

/**
 * Messages that mention `selfId` and that self hasn't answered: no later reply by self in the same
 * thread and no later top-level update by self on the same item. `updates` are top-level updates
 * (with `replies`) as the API returns them.
 */
function unansweredMentions(updates, selfId, sinceMs = 0) {
  const me = String(selfId);
  const mineOnItem = {};
  for (const u of updates) {
    if (String(u.creator_id) === me) {
      mineOnItem[u.item_id] = Math.max(mineOnItem[u.item_id] || 0, Date.parse(u.created_at));
    }
  }
  const out = [];
  for (const u of updates) {
    const thread = [u, ...(u.replies || [])].map((m) => ({ ...m, at: Date.parse(m.created_at) }));
    const lastMine = Math.max(0, ...thread.filter((m) => String(m.creator_id) === me).map((m) => m.at));
    for (const m of thread) {
      const mentionsMe = String(m.creator_id) !== me && mentionIds(m.body || '').includes(me);
      const answered = lastMine > m.at || (mineOnItem[u.item_id] || 0) > m.at;
      if (mentionsMe && !answered && m.at >= sinceMs) {
        out.push({ updateId: String(u.id), messageId: String(m.id), itemId: String(u.item_id), at: m.created_at, creatorId: String(m.creator_id), text: htmlToText(m.body) });
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function htmlToText(html) {
  return String(html || '').replace(/<\/(p|li|div)>|<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/[\u200B\uFEFF]/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{2,}/g, '\n').trim();
}

/** Activity events that only say someone followed the item. */
const NOISE_EVENTS = new Set(['subscribe', 'unsubscribe', 'add_owner', 'remove_owner']);

/** A column value from an activity log, as text: label, number, date, people, timeline or plain. */
function activityValue(textual, v, people = {}) {
  if (textual !== undefined && textual !== null && textual !== '') return String(textual);
  if (v === undefined || v === null || (typeof v === 'object' && !Object.keys(v).length)) return '(empty)';
  if (typeof v !== 'object') return String(v);
  if (v.label?.text !== undefined) return v.label.text;
  if (v.value !== undefined) return String(v.value);
  if (v.date) return v.time ? `${v.date} ${v.time}` : v.date;
  if (v.from && v.to) return `${v.from}..${v.to}`;
  if (v.personsAndTeams) return v.personsAndTeams.map((p) => nameOf(people, p.id)).join(', ') || '(empty)';
  if (v.text !== undefined) return String(v.text);
  return JSON.stringify(v);
}

/** One activity-log row as { at, userId, what }, or null for follow/unfollow noise. monday's created_at is in 100-nanosecond units. */
function describeActivity(log, people = {}) {
  if (NOISE_EVENTS.has(log.event)) return null;
  let d = {};
  try { d = JSON.parse(log.data || '{}'); } catch { /* keep the event name only */ }
  const at = new Date(Number(log.created_at) / 1e4).toISOString();
  const value = (t, v) => activityValue(t, v, people);
  const what = {
    update_column_value: () => `${d.column_title || d.column_id}: ${value(d.previous_textual_value, d.previous_value)} to ${value(d.textual_value, d.value)}`,
    create_pulse: () => 'created the item',
    update_name: () => `renamed from ${value(null, d.previous_value?.name ?? d.previous_value)} to ${value(null, d.value?.name ?? d.value)}`,
    move_pulse_from_group: () => `moved from group ${d.source_group?.title ?? '?'} to ${d.dest_group?.title ?? '?'}`,
    move_pulse_into_group: () => `moved to group ${d.dest_group?.title ?? '?'}`,
  }[log.event];
  return { at, userId: String(log.user_id), what: what ? what() : log.event.replace(/_/g, ' ') };
}

/** The handoff update body: the given HTML (or a default line), with each MR linked once. */
function handoffBody(body, { toName, mrs = [] }) {
  let html = body ? String(body) : `<p>@{${toName}} over to you.</p>`;
  for (const mr of mrs) {
    if (!html.includes(mr)) html += `<p>MR: <a href="${mr}">${mr}</a></p>`;
  }
  return html;
}

/** Put the greeting mention at the start of the first paragraph when the body doesn't mention them. */
function withGreeting(html, personId, anchorHtml) {
  if (mentionIds(html).includes(String(personId))) return html;
  return /^<p>/i.test(html) ? html.replace(/^<p>/i, `<p>${anchorHtml} `) : `<p>${anchorHtml}</p>${html}`;
}

/** The status a handoff moves to: the board's configured one, else its "Ready For QA"-like label. */
function defaultHandoffStatus(cfg) {
  return cfg.handoffStatus || Object.keys(cfg.statusLabels || {}).find((l) => /^ready\s*for\s*q/i.test(l)) || null;
}

/** Fill {itemId}/{mr}/{to}/{status} in a hook's argv; one run per MR when the hook uses {mr}. */
function hookRuns(argv, vars) {
  if (!Array.isArray(argv) || !argv.length) return [];
  const usesMr = argv.some((a) => a.includes('{mr}'));
  const mrs = usesMr ? vars.mrs : [null];
  return mrs.map((mr) => argv.map((a) => a.replace(/\{(itemId|mr|to|status)\}/g, (m, k) => String(k === 'mr' ? mr : vars[k] ?? ''))));
}

// ---- runtime state --------------------------------------------------------

let REF, TOKEN, api, upload, MCP;
let JSON_OUT = false;
let FLAGS = { cc: [], mr: [] };
function log(...a) { if (!JSON_OUT) console.log(...a); }
const DRY = () => !!FLAGS['dry-run'];
const mcp = () => (MCP ??= createMcpClient({ token: TOKEN }));

/** For tests: swap in a fake GraphQL client, MCP client and config. */
function setRuntime({ ref, api: apiImpl, upload: uploadImpl, mcp: mcpImpl, flags }) {
  if (ref) REF = normalize(ref);
  if (apiImpl) api = apiImpl;
  if (uploadImpl) upload = uploadImpl;
  if (mcpImpl) MCP = mcpImpl;
  FLAGS = { cc: [], mr: [], ...(flags || {}) };
  JSON_OUT = true;
}

function bootConfig() {
  REF = normalize(loadRaw());
}

function requireToken() {
  TOKEN = resolveToken({ env: process.env[REF.tokenEnvVar], saved: readSavedToken() });
  if (!TOKEN) {
    console.error(
      `No monday token found. Provide one:\n` +
      `  node mon.js login                    # paste it once; saved to ${tokenPath()}\n` +
      `  export ${REF.tokenEnvVar}=<token>       # or set it in the environment / ~/.claude/settings.json "env"`
    );
    process.exit(1);
  }
  ({ api, upload } = createClient({ endpoint: REF.endpoint, apiVersion: REF.apiVersion, token: TOKEN }));
}

// ---- API-backed helpers ---------------------------------------------------

/** Fetch all active users as a { name: id } map, paging through the account. */
async function fetchPeople() {
  const people = { _note: 'name (lowercased) is resolvable by mon.js assign/comment. id is the Monday user id.' };
  for (let page = 1; ; page++) {
    const d = await api(`query($p:Int!){ users(limit:200, page:$p){ id name enabled } }`, { p: page });
    const batch = d.users || [];
    batch.filter((u) => u.enabled !== false).forEach((u) => { people[u.name] = String(u.id); });
    if (batch.length < 200) break;
  }
  return people;
}

/** List every accessible active board, paging through. */
async function listBoards() {
  const out = [];
  for (let page = 1; ; page++) {
    const d = await api(`query($p:Int!){ boards(limit:100, page:$p, order_by:used_at, state:active){ id name } }`, { p: page });
    const batch = d.boards || [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Collect a board's items via cursor pagination, up to `cap`. `columnIds` limits fetched columns. */
async function collectItems(boardId, columnIds = [], cap = 5000) {
  const colSel = columnIds.length ? `column_values(ids:${JSON.stringify(columnIds)}){ id text }` : '';
  const itemSel = `cursor items{ id name ${colSel} }`;
  const items = [];
  let d = await api(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:100){ ${itemSel} } } }`, { b: [String(boardId)] });
  let page = d.boards?.[0]?.items_page;
  if (!page) throw new Error(`Board ${boardId} not found or not accessible.`);
  while (page && items.length < cap) {
    items.push(...(page.items || []));
    if (!page.cursor) break;
    const n = await api(`query($c:String!){ next_items_page(cursor:$c, limit:100){ ${itemSel} } }`, { c: page.cursor });
    page = n.next_items_page;
  }
  return items;
}

/** Look up the configured board an item belongs to. */
async function boardOf(itemId) {
  const d = await api(`query($id:[ID!]){ items(ids:$id){ board { id } } }`, { id: [String(itemId)] });
  const bid = String(d.items[0]?.board?.id);
  const cfg = REF.boards[bid];
  if (!cfg) throw new Error(`Item ${itemId} is on board ${bid}, which isn't configured. Run:  mon.js init ${bid}`);
  return cfg;
}

/**
 * Build board config for the given ids. Detects the status + people columns by type unless a
 * choice is already recorded in `existing` (so `refresh` never overrides a hand-picked column).
 */
async function configureBoards(boardIds, existing = {}) {
  const d = await api(
    `query($ids:[ID!]){ boards(ids:$ids){ id name columns{ id title type settings_str } } }`,
    { ids: boardIds.map(String) }
  );
  const boards = {};
  for (const b of d.boards || []) {
    const idStr = String(b.id);
    const prev = existing[idStr] || {};
    const statusColumn = prev.statusColumn || detectColumn(b.columns, STATUS_TYPES, 'status');
    const assigneeColumn = prev.assigneeColumn || detectColumn(b.columns, PEOPLE_TYPES, 'people');
    const statusCol = b.columns.find((c) => c.id === statusColumn);
    const columns = {};
    b.columns.forEach((c) => { columns[c.id] = { title: c.title, type: c.type }; });
    boards[idStr] = {
      id: Number(b.id),
      name: b.name,
      statusColumn: statusColumn || null,
      assigneeColumn: assigneeColumn || null,
      columns,
      statusLabels: statusCol ? labelsFromSettings(statusCol.settings_str) : {},
      aliases: prev.aliases || {},
      ...(prev.handoffStatus ? { handoffStatus: prev.handoffStatus } : {}),
    };
  }
  return boards;
}

function itemStatus(cfg, it) {
  if (!cfg?.statusColumn) return null;
  return it.column_values?.find((c) => c.id === cfg.statusColumn)?.text || null;
}

const UPDATE_FIELDS = 'id item_id created_at creator_id creator{ name } text_body body assets{ id name file_extension public_url } replies{ id created_at creator_id creator{ name } text_body body }';

const DESC_PAGE = 100;

/** Every block of an item's description: `blocks` silently returns only its first 25 unless paged. */
async function descriptionBlocks(itemId) {
  const blocks = [];
  for (let page = 1; ; page++) {
    const d = await api(`query($id:[ID!],$p:Int){ items(ids:$id){ description{ blocks(limit:${DESC_PAGE}, page:$p){ id type content } } } }`, { id: [String(itemId)], p: page });
    const got = d.items[0]?.description?.blocks || [];
    blocks.push(...got);
    if (got.length < DESC_PAGE) return blocks;
  }
}

/** An item's board with live column definitions (titles, types, settings) for `set`/`estimate`/`insights`. */
async function boardColumnsOf(itemId) {
  const d = await api(`query($id:[ID!]){ items(ids:$id){ name board{ id name columns{ id title type settings_str } } } }`, { id: [String(itemId)] });
  const it = d.items[0];
  if (!it) throw new Error(`Item ${itemId} not found`);
  return { itemName: it.name, board: it.board, aliases: REF.boards[String(it.board.id)]?.aliases || {} };
}

async function boardColumns(boardId) {
  const d = await api(`query($b:[ID!]){ boards(ids:$b){ id name columns{ id title type settings_str } } }`, { b: [String(boardId)] });
  if (!d.boards?.[0]) throw new Error(`Board ${boardId} not found or not accessible.`);
  return d.boards[0];
}

/** Print what a write would send and return it, or run `send` and return its result. */
async function write(label, details, send) {
  if (DRY()) {
    log(`[dry run] ${label}`);
    Object.entries(details).forEach(([k, v]) => log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`));
    return { dryRun: true, action: label, ...details };
  }
  return send();
}

async function changeColumns(boardId, itemId, values) {
  const ids = Object.keys(values);
  const d = await api(
    `mutation($b:ID!,$i:ID!,$cv:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$cv){ column_values(ids:${JSON.stringify(ids)}){ id text } } }`,
    { b: String(boardId), i: String(itemId), cv: JSON.stringify(values) }
  );
  return Object.fromEntries(d.change_multiple_column_values.column_values.map((c) => [c.id, c.text]));
}

function validStatus(cfg, label) {
  if (!cfg.statusColumn) throw new Error(`No status column configured for board ${cfg.id}. Set "statusColumn" in reference.json.`);
  if (!(label in cfg.statusLabels)) {
    throw new Error(`"${label}" is not a valid status on "${cfg.name}". Run  mon.js refresh  if the board's labels changed. Valid: ${Object.keys(cfg.statusLabels).join(', ')}`);
  }
  return label;
}

function requireAssigneeColumn(cfg) {
  if (!cfg.assigneeColumn) throw new Error(`No assignee column configured for board ${cfg.id}. Set "assigneeColumn" in reference.json.`);
  return cfg.assigneeColumn;
}

const person = (n) => resolvePerson(REF.people, n);

/** The final HTML for a post, through the mention/CC/minify/style pipeline. */
function composeBody(body) {
  return composePost(resolveBody(body), { people: REF.people, resolve: resolvePerson, cc: FLAGS.cc, allowStyle: !!FLAGS['allow-style'] });
}

async function createUpdate(itemId, html, parentId = null) {
  const d = await api(
    `mutation($i:ID!,$p:ID,$b:String!){ create_update(item_id:$i,parent_id:$p,body:$b){ id creator{ name } } }`,
    { i: String(itemId), p: parentId ? String(parentId) : null, b: html }
  );
  return { id: String(d.create_update.id), author: d.create_update.creator.name };
}

async function download(assets, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const asset of assets) {
    const res = await fetch(asset.public_url);
    if (!res.ok) throw new Error(`download failed for asset ${asset.id}: HTTP ${res.status}`);
    const out = path.join(dir, `${asset.id}-${asset.name}`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    log(out);
    saved.push(out);
  }
  return saved;
}

const shortDate = (iso) => String(iso).replace('T', ' ').slice(0, 16);

function printUpdate(u, indent = '') {
  log(`${indent}[${u.id}] ${shortDate(u.created_at)}  ${u.creator?.name ?? u.creator_id}`);
  (u.text_body || '(empty)').split('\n').filter(Boolean).forEach((l) => log(`${indent}  ${l}`));
  (u.assets || []).forEach((a) => log(`${indent}  assetId:${a.id}  ${a.name}`));
  (u.replies || []).forEach((r) => printUpdate(r, indent + '    '));
}

const updateJson = (u) => ({
  id: String(u.id), itemId: u.item_id ? String(u.item_id) : undefined, at: u.created_at, author: u.creator?.name, text: u.text_body || '',
  assets: (u.assets || []).map((a) => ({ id: String(a.id), name: a.name })),
  replies: (u.replies || []).map((r) => ({ id: String(r.id), at: r.created_at, author: r.creator?.name, text: r.text_body || '' })),
});

/** An update id, or a post URL (.../pulses/<itemId>/posts/<updateId>) that also names its item. */
function updateRef(arg) {
  const m = /pulses\/(\d+)\/posts\/(\d+)/.exec(String(arg || ''));
  return m ? { id: m[2], itemId: m[1] } : { id: String(arg), itemId: FLAGS.item || null };
}

/**
 * An update or a reply, by id or post URL. `updates(ids:)` returns top-level updates only, so a reply
 * is found through its item (`--item <id>`, or the item in the post URL). `parentId` is set for a reply.
 */
async function findUpdate(arg) {
  const { id, itemId } = updateRef(arg);
  const top = (await api(`query($ids:[ID!]){ updates(ids:$ids){ ${UPDATE_FIELDS} item{ name } } }`, { ids: [id] })).updates[0];
  if (top) return { ...top, parentId: null };
  if (!itemId) throw new Error(`Update ${id} not found. If it's a reply, pass --item <itemId> or its post URL (.../pulses/<itemId>/posts/<id>).`);
  const it = (await api(`query($i:[ID!]){ items(ids:$i){ name updates(limit:100){ id replies{ id created_at creator_id creator{ name } text_body body assets{ id name file_extension public_url } } } } }`, { i: [String(itemId)] })).items[0];
  for (const u of it?.updates || []) {
    const r = (u.replies || []).find((x) => String(x.id) === id);
    if (r) return { ...r, item_id: String(itemId), item: { name: it.name }, replies: [], parentId: String(u.id) };
  }
  throw new Error(`Update ${id} not found on item ${itemId}.`);
}

async function selfId() {
  if (REF.self?.id) return String(REF.self.id);
  return String((await api(`query { me { id } }`)).me.id);
}

/** The session-links store; needs node:sqlite (Node 22.13+). */
function links() {
  try {
    return require('./lib/links').openLinks(linksDbPath());
  } catch (e) {
    throw new Error(`The session links store needs Node 22.13+ (node:sqlite): ${e.message}`);
  }
}

/** Tie MRs to a monday item, with each MR's branch when its host CLI can tell. Never fails the caller. */
function linkMrs(itemId, mrs, source) {
  if (!mrs.length) return [];
  try {
    const { mrInfo } = require('./lib/links');
    const store = links();
    try {
      return mrs.map((url) => {
        const branch = mrInfo(url)?.branch || null;
        store.addMr({ url, branch });
        store.linkTaskMr(itemId, url, source);
        if (branch) store.linkTaskBranch(itemId, require('./lib/links').mrRepo(url), branch, source);
        return { url, branch };
      });
    } finally {
      store.close();
    }
  } catch (e) {
    log(`(MRs not linked: ${e.message})`);
    return [];
  }
}

/** Backfill the links store from transcripts touched since `sinceMs`. */
function importTranscripts(store, sinceMs) {
  const t = require('./lib/transcripts');
  const { itemIdsIn, mrUrlsIn } = require('./lib/links');
  let sessions = 0;
  let mrs = 0;
  for (const file of t.transcriptFiles(sinceMs)) {
    let f;
    try { f = t.readTranscript(file); } catch { continue; }
    if (!f.first || t.isAutomated(f.cwd)) continue;
    sessions++;
    store.touchSession({ id: f.session, transcript: file, cwd: f.cwd, at: f.first });
    store.touchSession({ id: f.session, at: f.last });
    const counts = new Map();
    const count = (repo, branch, cwd, n) => {
      if (!repo || !branch) return;
      const k = `${repo}\u0000${branch}`;
      counts.set(k, { repo, branch, cwd, events: (counts.get(k)?.events || 0) + n });
    };
    for (const [key, n] of f.branchEvents) {
      const [cwd, branch] = key.split('\u0000');
      count(t.checkoutOf(cwd).repo, branch, cwd, n);
    }
    for (const e of f.edits) {
      const c = t.checkoutOf(path.dirname(e.file));
      count(c.repo, c.branch, path.dirname(e.file), 1);
    }
    for (const c of counts.values()) store.touchBranch({ session: f.session, ...c, at: f.last, replace: true });
    const named = [];
    for (const p of f.prompts) {
      for (const item of itemIdsIn(p.text)) {
        store.linkTaskSession(item, f.session, 'prompt', p.at);
        store.linkTaskBranch(item, t.checkoutOf(p.cwd).repo, p.branch, 'prompt', p.at);
        named.push({ at: p.at, item });
      }
      mrUrlsIn(p.text).forEach((url) => store.linkSessionMr(f.session, url, 'mentioned', p.at));
    }
    for (const m of f.createdMrs) {
      const dir = t.commandDir(m.command, m.cwd);
      const c = t.checkoutOf(dir);
      // the task in focus when the MR was raised, not one named later in the session
      const before = named.filter((n) => n.at <= m.at).pop();
      const items = itemIdsIn(m.command).length ? itemIdsIn(m.command) : before ? [before.item] : [];
      for (const url of mrUrlsIn(m.output)) {
        store.recordCreatedMr({ session: f.session, url, repo: c.repo, branch: t.commandSourceBranch(m.command) || c.branch, commandText: m.command, at: m.at, items });
        mrs++;
      }
    }
    store.setTitle(f.session, f.title);
  }
  return { sessions, mrs };
}

function printLinks(r, names) {
  if (!r.items.length && !r.mrs.length && !r.sessions.length) { log('nothing linked yet'); return; }
  r.items.forEach((id) => log(`task ${id}${names[id] ? `  ${names[id]}` : ''}`));
  if (r.mrs.length) log('MRs:');
  r.mrs.forEach((m) => log(`  ${m.url}${m.branch ? `  (${m.repo}:${m.branch})` : ''}`));
  if (r.sessions.length) log('Claude sessions, best match first:');
  r.sessions.forEach((s) => {
    log(`  ${s.id}  ${s.title || '(unnamed)'}  last ${shortDate(s.lastAt || '')}  [${s.how.join('; ')}${s.branchEvents ? `, ${s.branchEvents} events on the branch` : ''}]`);
    if (s.cwd) log(`    resume: cd ${s.cwd} && claude --resume ${s.id}`);
  });
}

/** Items in `list` grouped by `key`, biggest group first. */
function groupBy(list, key) {
  const m = new Map();
  list.forEach((x) => m.set(key(x), [...(m.get(key(x)) || []), x]));
  return [...m].sort((a, b) => b[1].length - a[1].length);
}

/** Open (not done) items assigned to `me` on the configured boards. */
async function myOpenItems(me, boards) {
  const open = [];
  for (const b of boards.filter((x) => x.assigneeColumn)) {
    const cols = JSON.stringify([b.statusColumn].filter(Boolean));
    const sel = `cursor items{ id name parent_item{ name } column_values(ids:${cols}){ text } }`;
    let page = (await api(
      `query($b:[ID!],$v:CompareValue!){ boards(ids:$b){ items_page(limit:100, query_params:{rules:[{column_id:"${b.assigneeColumn}", compare_value:$v, operator:any_of}]}){ ${sel} } } }`,
      { b: [String(b.id)], v: [`person-${me}`] }
    )).boards[0]?.items_page;
    while (page) {
      for (const it of page.items) {
        const status = it.column_values[0]?.text || null;
        // a subitem's own name ("backend") means little without its task's
        const name = it.parent_item?.name ? `${it.parent_item.name} > ${it.name}` : it.name;
        if (!isDoneStatus(status, REF.doneStatuses)) open.push({ id: String(it.id), name, status, board: b.name });
      }
      if (!page.cursor || open.length > 1000) break;
      page = (await api(`query($c:String!){ next_items_page(cursor:$c, limit:100){ ${sel} } }`, { c: page.cursor })).next_items_page;
    }
  }
  return open;
}

/** Updates on the configured boards that mention `me` and that I haven't answered, newest first, with item names. */
async function unansweredMentionsOf(me, boards, since) {
  const updates = [];
  for (const b of boards) {
    for (let p = 1; p <= 5; p++) {
      const batch = (await api(`query($b:[ID!],$p:Int!){ boards(ids:$b){ updates(limit:100, page:$p){ id item_id created_at creator_id body replies{ id creator_id created_at body } } } }`, { b: [String(b.id)], p }))
        .boards[0]?.updates || [];
      updates.push(...batch);
      if (batch.length < 100 || Date.parse(batch[batch.length - 1].created_at) < since) break;
    }
  }
  const pending = unansweredMentions(updates, me, since);
  const names = {};
  const ids = [...new Set(pending.map((m) => m.itemId))];
  for (let i = 0; i < ids.length; i += 100) {
    (await api(`query($i:[ID!]){ items(ids:$i){ id name } }`, { i: ids.slice(i, i + 100) })).items.forEach((it) => { names[it.id] = it.name; });
  }
  return pending.map((m) => ({ ...m, author: nameOf(REF.people, m.creatorId), itemName: names[m.itemId] || null }));
}

/** How many Claude sessions the session links tie to each item; {} when links aren't available. */
function sessionCounts(itemIds) {
  if (!itemIds.length) return {};
  try {
    const store = links();
    try {
      return Object.fromEntries(itemIds.map((id) => [id, store.resolve({ item: id }).sessions.length]));
    } finally {
      store.close();
    }
  } catch {
    return {};
  }
}

// ---- commands -------------------------------------------------------------

const cmds = {
  async login(args) {
    let token = (args.find((a) => a && !a.startsWith('-')) || '').trim();
    if (!token) token = await readSecret('Paste your monday API token (input hidden): ');
    if (!token) throw new Error('No token provided.');
    let me;
    try {
      me = (await createClient({ endpoint: REF.endpoint, apiVersion: REF.apiVersion, token }).api(`query { me { id name email } }`)).me;
    } catch (e) {
      throw new Error(`monday rejected that token (${e.message}). Nothing saved.`);
    }
    const savedTo = saveToken(token);
    log(`saved token for ${me.name} <${me.email}> to ${savedTo}`);
    return { savedTo, user: { id: String(me.id), name: me.name, email: me.email } };
  },

  /**
   * First-run setup, safe to re-run: token, boards, session-links hook, backfill.
   * Interactive on a terminal; `--boards <ids> --yes` runs it without questions (the token must
   * already be saved or in the environment, so it never passes through a chat).
   */
  async setup() {
    const yes = !!FLAGS.yes;
    const confirm = async (q) => yes || /^(y|yes|)$/i.test(await ask(`${q} [Y/n] `));
    log('1. monday token');
    let token = resolveToken({ env: process.env[REF.tokenEnvVar], saved: readSavedToken() });
    if (!token) {
      if (!process.stdin.isTTY) throw new Error('No monday token yet. Run  node mon.js setup  in a terminal (it asks for the token, hidden), then re-run this.');
      log('   Get one in monday.com: your avatar, Developers, My access tokens.');
      await cmds.login([]);
      token = readSavedToken();
    }
    TOKEN = token;
    api = createClient({ endpoint: REF.endpoint, apiVersion: REF.apiVersion, token }).api;
    const me = (await api('query { me { id name email } }')).me;
    log(`   acting as ${me.name} <${me.email}>`);

    log('2. boards to track');
    const configured = Object.values(REF.boards);
    if (configured.length) log(`   already: ${configured.map((b) => `${b.name} (${b.id})`).join(', ')}`);
    let picked = FLAGS.boards ? FLAGS.boards.split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (!picked) {
      const boards = await listBoards();
      boards.slice(0, 60).forEach((b, i) => log(`   ${String(i + 1).padStart(3)}. ${b.name}  (${b.id})`));
      if (boards.length > 60) log(`   ... ${boards.length - 60} more; pass ids with --boards`);
      const answer = await ask(configured.length ? '   Add boards (numbers or ids, comma separated; Enter to keep): ' : '   Which boards? (numbers or ids, comma separated): ');
      if (!answer && !configured.length && !process.stdin.isTTY) throw new Error('Pick boards with  mon.js setup --boards <id,id> --yes');
      picked = pickBoards(answer, boards);
    }
    if (picked.length) await cmds.init(picked);

    log('3. session links (which Claude sessions, monday items and MRs belong together)');
    const settings = require('./lib/claude-settings');
    const asPlugin = !!process.env.CLAUDE_PLUGIN_ROOT || __dirname.startsWith(path.join(require('os').homedir(), '.claude', 'plugins') + path.sep);
    let hookReady = false;
    try {
      require('node:sqlite');
      hookReady = true;
    } catch {
      log(`   skipped: needs Node 22.13+ (this is ${process.version})`);
    }
    if (hookReady && asPlugin) log('   the plugin registers the hook itself');
    if (hookReady && !asPlugin && !FLAGS['no-hooks']) {
      const current = settings.readSettings(settings.SETTINGS);
      if (settings.hasLinksHook(current)) log('   hook already in ~/.claude/settings.json');
      else if (await confirm('   Register the hook in ~/.claude/settings.json (a .bak of it is kept)?')) {
        settings.writeSettings(settings.SETTINGS, settings.withLinksHook(current, path.join(__dirname, 'hooks', 'links-hook.js')));
        log('   registered; new sessions record links from now on');
      }
    }

    // retention is the user's choice; only say what it means for links
    const days = settings.readSettings(settings.SETTINGS).cleanupPeriodDays || 30;
    if (days < 180) log(`   note: Claude Code keeps transcripts ${days} days, so older linked sessions can't be resumed. Raise "cleanupPeriodDays" in ~/.claude/settings.json if you want them longer.`);

    if (hookReady) {
      log('4. backfill links from your existing transcripts (local only)');
      const store = links();
      try {
        const r = importTranscripts(store, Date.now() - 180 * 86400000);
        log(`   ${r.sessions} sessions, ${r.mrs} MRs they created`);
      } finally {
        store.close();
      }
    }
    log(`\nDone. Try:  node ${path.join(__dirname, 'mon.js')} mine`);
    log(`For mr-rebase-bot, set in its config:  "sessionIndex": ["node", "${path.join(__dirname, 'mon.js')}", "links", "{mr}", "--json", "--no-names"]`);
    return { user: me, boards: Object.keys(REF.boards), hook: hookReady };
  },

  async logout() {
    const p = tokenPath();
    const existed = fs.existsSync(p);
    if (existed) fs.unlinkSync(p);
    log(existed ? `removed saved token at ${p}` : 'no saved token to remove');
    return { removed: existed, path: p };
  },

  async whoami() {
    const d = await api(`query { me { id name email } }`);
    log(`${d.me.name} <${d.me.email}> (id ${d.me.id})`);
    return { id: String(d.me.id), name: d.me.name, email: d.me.email };
  },

  async people([filter]) {
    const lc = (filter || '').toLowerCase();
    const rows = Object.entries(REF.people).filter(([n]) => n[0] !== '_' && n.toLowerCase().includes(lc)).map(([name, id]) => ({ name, id: String(id) }));
    rows.forEach((r) => log(`  ${r.id}  ${r.name}`));
    if (!rows.length) log(`nobody matches "${filter}" (new teammate? run  mon.js refresh)`);
    return rows;
  },

  async init(boardIds) {
    if (!boardIds.length) {
      const boards = await listBoards();
      log('Your boards. Configure one or more with:  mon.js init <boardId> [more...]\n');
      boards.forEach((b) => log(`  ${b.id}  ${b.name}`));
      return { boards: boards.map((b) => ({ id: String(b.id), name: b.name })) };
    }
    const me = (await api(`query { me { id name email } }`)).me;
    REF.self = { id: String(me.id), name: me.name, email: me.email };
    REF.people = await fetchPeople();
    const built = await configureBoards(boardIds, REF.boards);
    REF.boards = { ...REF.boards, ...built };
    const savedTo = writeRef(REF);
    const configured = [];
    let ambiguous = false;
    for (const id of boardIds) {
      const b = REF.boards[String(id)];
      if (!b) { log(`  ${id}: not found or not accessible`); continue; }
      const title = (colId) => b.columns[colId]?.title || colId;
      log(`configured "${b.name}" (${id}): status=${b.statusColumn ? title(b.statusColumn) : '(none found)'}, assignee=${b.assigneeColumn ? title(b.assigneeColumn) : '(none found)'}, ${Object.keys(b.statusLabels).length} labels`);
      const cands = (types, chosen) => Object.entries(b.columns)
        .filter(([, c]) => types.has(c.type))
        .map(([cid, c]) => `${c.title} (${cid})${cid === chosen ? ' <- using' : ''}`);
      const statusCands = cands(STATUS_TYPES, b.statusColumn);
      const peopleCands = cands(PEOPLE_TYPES, b.assigneeColumn);
      if (statusCands.length > 1) { ambiguous = true; log(`  ! ${statusCands.length} status columns: ${statusCands.join(', ')}`); }
      if (peopleCands.length > 1) { ambiguous = true; log(`  ! ${peopleCands.length} people columns: ${peopleCands.join(', ')}`); }
      configured.push({ id: String(id), name: b.name, statusColumn: b.statusColumn, assigneeColumn: b.assigneeColumn, labels: Object.keys(b.statusLabels).length });
    }
    log(`people: ${Object.keys(REF.people).filter((k) => k[0] !== '_').length}  (saved to ${savedTo})`);
    if (ambiguous) log(`If a "<- using" column above is wrong, set the right id as "statusColumn"/"assigneeColumn" in reference.json (refresh keeps your choice).`);
    return { savedTo, boards: configured, people: Object.keys(REF.people).filter((k) => k[0] !== '_').length };
  },

  async refresh() {
    const ids = Object.keys(REF.boards);
    if (!ids.length) throw new Error('Nothing configured yet. Run:  mon.js init <boardId> [more...]');
    REF.people = await fetchPeople();
    REF.boards = await configureBoards(ids, REF.boards);
    const savedTo = writeRef(REF);
    const people = Object.keys(REF.people).filter((k) => k[0] !== '_').length;
    log(`refreshed ${ids.length} board(s), ${people} people  (saved to ${savedTo})`);
    return { savedTo, boards: ids.length, people };
  },

  async list([boardId]) {
    if (!boardId) throw new Error('Usage: list <boardId>   (board ids: mon.js init)');
    const cfg = REF.boards[String(boardId)];
    const items = await collectItems(boardId, cfg?.statusColumn ? [cfg.statusColumn] : []);
    const rows = items.map((it) => ({ id: String(it.id), name: it.name, status: itemStatus(cfg, it) }));
    rows.forEach((r) => log(`  ${r.id}  ${r.name}${r.status ? '  [' + r.status + ']' : ''}`));
    log(`${rows.length} item(s)`);
    return { boardId: String(boardId), count: rows.length, items: rows };
  },

  async search([boardId, text]) {
    if (!boardId || !text) throw new Error('Usage: search <boardId> "<text>"');
    const cfg = REF.boards[String(boardId)];
    const lc = text.toLowerCase();
    const items = (await collectItems(boardId, cfg?.statusColumn ? [cfg.statusColumn] : []))
      .filter((it) => (it.name || '').toLowerCase().includes(lc));
    const rows = items.map((it) => ({ id: String(it.id), name: it.name, status: itemStatus(cfg, it) }));
    rows.forEach((r) => log(`  ${r.id}  ${r.name}${r.status ? '  [' + r.status + ']' : ''}`));
    log(`${rows.length} match(es) for "${text}"`);
    return { boardId: String(boardId), query: text, count: rows.length, items: rows };
  },

  async get([itemId]) {
    if (!itemId) throw new Error('Usage: get <itemId> [--full] [--updates N]');
    const full = !!FLAGS.full;
    const n = Number(FLAGS.updates || (full ? 5 : 0));
    const d = await api(
      `query($id:[ID!]){ items(ids:$id){ id name url group{title} board{id name} column_values{ id type text column{ title } }
        ${n ? `updates(limit:${n}){ ${UPDATE_FIELDS} }` : ''} } }`,
      { id: [String(itemId)] }
    );
    const it = d.items[0];
    if (!it) throw new Error(`Item ${itemId} not found`);
    const cfg = REF.boards[String(it.board.id)] || {};
    log(`${it.name}  (item ${it.id})`);
    log(`board: ${it.board.name} (${it.board.id}) | group: ${it.group?.title}${REF.boards[String(it.board.id)] ? '' : '  (board not configured: mon.js init ' + it.board.id + ')'}`);
    const cols = it.column_values.filter((c) => c.text || full).map((c) => {
      const role = c.id === cfg.statusColumn ? 'status' : c.id === cfg.assigneeColumn ? 'assignee' : null;
      if (c.text) log(`  ${c.column?.title || c.id}${full ? ` (${c.id}, ${c.type})` : ''}${role ? ' [' + role + ']' : ''}: ${c.text}`);
      return { id: c.id, type: c.type, title: c.column?.title || c.id, text: c.text, role };
    });
    const out = { id: String(it.id), name: it.name, url: it.url, board: { id: String(it.board.id), name: it.board.name }, group: it.group?.title, columns: cols.filter((c) => c.text) };
    if (full) {
      out.emptyColumns = cols.filter((c) => !c.text).map((c) => ({ id: c.id, type: c.type, title: c.title }));
      log(`  (empty: ${out.emptyColumns.map((c) => `${c.title} (${c.id})`).join(', ')})`);
      out.description = blocksToMarkdown(await descriptionBlocks(itemId));
      log('--- description ---');
      log(out.description || '(empty)');
    }
    if (n) {
      const ups = [...(it.updates || [])].reverse();
      log(`--- last ${ups.length} update(s), oldest first ---`);
      ups.forEach((u) => printUpdate(u));
      out.updates = ups.map(updateJson);
    }
    return out;
  },

  async mine() {
    const me = await selfId();
    const days = Number(FLAGS.days || 14);
    const boards = Object.values(REF.boards);
    if (!boards.length) throw new Error('Nothing configured yet. Run:  mon.js init <boardId> [more...]');
    const by = FLAGS.by || 'status';
    if (!['status', 'board'].includes(by)) throw new Error('mine --by takes "status" or "board"');
    const open = await myOpenItems(me, boards);
    const sessions = sessionCounts(open.map((it) => it.id));
    open.forEach((it) => { it.sessions = sessions[it.id] || 0; });
    // --status "Ready To Start,Ready For Estimation" keeps only those (case-insensitive): the tasks to pick from
    const wanted = FLAGS.status ? new Set(FLAGS.status.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) : null;
    const visible = open.filter((it) => (wanted ? wanted.has((it.status || '').toLowerCase()) : FLAGS.all || !isParkedStatus(it.status)));
    const parked = wanted ? [] : open.filter((it) => !FLAGS.all && isParkedStatus(it.status));
    const tag = (it) => (it.sessions ? `  [${it.sessions} session${it.sessions > 1 ? 's' : ''}]` : '');
    const labels = FLAGS.status ? FLAGS.status.split(',').map((x) => x.trim()).filter(Boolean) : [];
    log(`${wanted ? `Assigned to me, ${labels.slice(0, -1).join(', ')}${labels.length > 1 ? ' or ' : ''}${labels.at(-1)}` : 'Open items assigned to me'}: ${visible.length}`);
    if (by === 'board') {
      for (const [board, items] of groupBy(visible, (it) => it.board)) {
        log(`\n${board} (${items.length})`);
        const width = Math.max(...items.map((it) => (it.status || '').length));
        items.sort((x, y) => (x.status || '').localeCompare(y.status || '') || x.name.localeCompare(y.name))
          .forEach((it) => log(`  ${(it.status || '(no status)').padEnd(width)}  ${it.id}  ${it.name}${tag(it)}`));
      }
    } else {
      for (const [status, items] of groupBy(visible, (it) => it.status || '(no status)')) {
        log(`  ${status} (${items.length})`);
        items.forEach((it) => log(`    ${it.id}  ${it.name}${boards.length > 1 ? `  (${it.board})` : ''}${tag(it)}`));
      }
    }
    if (parked.length) log(`\n  also parked: ${[...groupBy(parked, (it) => it.status)].map(([st, its]) => `${st} ${its.length}`).join(', ')}  (--all lists them)`);
    if (FLAGS.tasks) return { open: visible, parked: parked.length };

    const pending = await unansweredMentionsOf(me, boards, Date.now() - days * 86400000);
    log(`\nMentions I haven't answered (last ${days} days): ${pending.length}`);
    pending.forEach((m) => {
      log(`  ${shortDate(m.at)}  ${m.author} on "${m.itemName || m.itemId}" (item ${m.itemId}, update ${m.updateId})`);
      log(`    ${m.text.replace(/\n/g, ' ').slice(0, 160)}`);
    });
    return { open: visible, parked: parked.length, mentions: pending };
  },

  async updates([itemId]) {
    if (!itemId) throw new Error('Usage: updates <itemId> [--limit N] [--images <dir>]');
    const n = Number(FLAGS.limit || 20);
    const d = await api(`query($id:[ID!]){ items(ids:$id){ name updates(limit:${n}){ ${UPDATE_FIELDS} } } }`, { id: [String(itemId)] });
    const it = d.items[0];
    if (!it) throw new Error(`Item ${itemId} not found`);
    const ups = [...it.updates].reverse();
    log(`${it.name}: ${ups.length} update(s), oldest first`);
    ups.forEach((u) => printUpdate(u));
    const out = { itemId: String(itemId), name: it.name, updates: ups.map(updateJson) };
    if (FLAGS.images) out.saved = await download(ups.flatMap((u) => u.assets || []), FLAGS.images);
    return out;
  },

  async ['update-get']([updateId]) {
    if (!updateId) throw new Error('Usage: update-get <updateId|postUrl> [--item <itemId>]');
    const u = await findUpdate(updateId);
    log(`${u.parentId ? `reply under update ${u.parentId}` : 'update'} ${u.id} on item ${u.item_id} (${u.item?.name ?? '?'})`);
    printUpdate(u);
    if (u.assets?.length) log(`(download: mon.js update-images ${u.id} [outDir])`);
    return { ...updateJson(u), itemName: u.item?.name ?? null, parentId: u.parentId };
  },

  async ['update-images']([updateId, outDir]) {
    const assets = (await findUpdate(updateId)).assets || [];
    if (!assets.length) { log('no images/assets in update'); return { saved: [] }; }
    return { saved: await download(assets, outDir || process.cwd()) };
  },

  async ['desc-get']([itemId]) {
    const md = blocksToMarkdown(await descriptionBlocks(itemId));
    log(md);
    return { itemId: String(itemId), markdown: md };
  },

  async ['desc-images']([itemId, outDir]) {
    const assetIds = (await descriptionBlocks(itemId))
      .filter((b) => b.type === 'image')
      .map((b) => { try { return JSON.parse(b.content).assetId; } catch { return null; } })
      .filter(Boolean);
    if (!assetIds.length) { log('no images in description'); return { saved: [] }; }
    const a = await api(`query($ids:[ID!]!){ assets(ids:$ids){ id name public_url } }`, { ids: assetIds.map(String) });
    return { saved: await download(a.assets, outDir || process.cwd()) };
  },

  async activity([itemId]) {
    if (!itemId) throw new Error('Usage: activity <itemId> [--days N]');
    const days = Number(FLAGS.days || 30);
    const { board } = await boardColumnsOf(itemId);
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const d = await api(
      `query($b:[ID!],$i:[ID!],$f:ISO8601DateTime){ boards(ids:$b){ activity_logs(item_ids:$i, from:$f, limit:200){ event user_id created_at data } } }`,
      { b: [String(board.id)], i: [String(itemId)], f: from }
    );
    const rows = (d.boards[0]?.activity_logs || []).map((l) => describeActivity(l, REF.people)).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
    rows.forEach((r) => log(`  ${shortDate(r.at)}  ${nameOf(REF.people, r.userId)}: ${r.what}`));
    if (!rows.length) log(`no activity in the last ${days} days`);
    return rows.map((r) => ({ ...r, user: nameOf(REF.people, r.userId) }));
  },

  async status([itemId, label]) {
    if (!itemId || !label) throw new Error('Usage: status <itemId> "<label>"');
    const cfg = await boardOf(itemId);
    validStatus(cfg, label);
    return write(`set status of ${itemId}`, { column: cfg.statusColumn, label }, async () => {
      const text = (await changeColumns(cfg.id, itemId, JSON.parse(statusColumnValues(cfg.statusColumn, label))))[cfg.statusColumn];
      log(`status -> ${text}`);
      return { itemId: String(itemId), status: text };
    });
  },

  async assign([itemId, ...names]) {
    if (!itemId || !names.length) throw new Error('Usage: assign <itemId> <name|id> [more...]');
    const cfg = await boardOf(itemId);
    const col = requireAssigneeColumn(cfg);
    const ids = names.map(person);
    return write(`assign ${itemId}`, { column: col, people: ids.map((id) => `${nameOf(REF.people, id)} (${id})`) }, async () => {
      const text = (await changeColumns(cfg.id, itemId, JSON.parse(assigneeColumnValues(col, ids))))[col];
      log(`assignee -> ${text}`);
      return { itemId: String(itemId), assignee: text };
    });
  },

  async set([itemId, column, ...values]) {
    if (!itemId || !column) throw new Error('Usage: set <itemId> "<column id|alias|title>" <value...>   ("" clears)');
    const { board, aliases } = await boardColumnsOf(itemId);
    const col = findColumn(board.columns, column, aliases);
    const value = columnValue(col, values, person);
    return write(`set ${col.title} (${col.id}, ${col.type}) on ${itemId}`, { value }, async () => {
      const text = (await changeColumns(board.id, itemId, { [col.id]: value }))[col.id];
      log(`${col.title} -> ${text || '(empty)'}`);
      return { itemId: String(itemId), column: col.id, title: col.title, text };
    });
  },

  async estimate([itemId, hours]) {
    if (!itemId || hours === undefined) throw new Error('Usage: estimate <itemId> <hours>');
    const { board, aliases } = await boardColumnsOf(itemId);
    const col = findEstimateColumn(board.columns, aliases);
    return cmds.set([itemId, col.id, hours]);
  },

  async update([itemId, body]) {
    if (!itemId || !body) throw new Error('Usage: update <itemId> "<html>|@file|-" [--cc A,B]   (write @First or @{Full Name} to mention)');
    const post = composeBody(body);
    return write(`post update on item ${itemId}`, { html: post.html, mentions: post.mentions.map((m) => `${m.name} (${m.id})`) }, async () => {
      const u = await createUpdate(itemId, post.html);
      log(`update ${u.id} posted on item ${itemId} as ${u.author}`);
      return { updateId: u.id, author: u.author, mentions: post.mentions };
    });
  },

  async comment([itemId, body, ...extra]) {
    if (extra.length) throw new Error('comment no longer takes @Name arguments (they added a duplicate footer). Write @Name inline in the body, or use --cc A,B.');
    return cmds.update([itemId, body]);
  },

  async reply([updateId, body]) {
    if (!updateId || !body) throw new Error('Usage: reply <updateId> "<html>|@file|-" [--cc A,B]');
    const post = composeBody(body);
    const target = await findUpdate(updateId);
    const itemId = target.item_id;
    // monday doesn't nest replies: answering a reply goes under its update
    const threadId = target.parentId || String(target.id);
    return write(`reply under update ${threadId} (item ${itemId})`, { html: post.html, mentions: post.mentions.map((m) => `${m.name} (${m.id})`) }, async () => {
      const u = await createUpdate(itemId, post.html, threadId);
      log(`reply ${u.id} posted under update ${threadId} (item ${itemId}) as ${u.author}`);
      return { replyId: u.id, parentUpdateId: threadId, itemId: String(itemId) };
    });
  },

  async ['update-edit']([updateId, body]) {
    if (!updateId || !body) throw new Error('Usage: update-edit <updateId|postUrl> "<html>|@file|-" [--item <itemId>]');
    const old = await findUpdate(updateId);
    updateId = String(old.id);
    const post = composeBody(body);
    const before = new Set(mentionIds(old.body));
    const added = mentionIds(post.html).filter((id) => !before.has(id));
    if (added.length) {
      throw new Error(`An edit can't add mentions (monday doesn't ping on edit): ${added.map((id) => nameOf(REF.people, id)).join(', ')}. Delete the update and post it again instead.`);
    }
    return write(`edit update ${updateId}`, { html: post.html }, async () => {
      const d = await api(`mutation($id:ID!,$b:String!){ edit_update(id:$id, body:$b){ id updated_at } }`, { id: String(updateId), b: post.html });
      log(`update ${updateId} edited at ${d.edit_update.updated_at}`);
      return { updateId: String(updateId), updatedAt: d.edit_update.updated_at };
    });
  },

  async ['update-delete']([updateId]) {
    if (!updateId) throw new Error('Usage: update-delete <updateId|postUrl> [--item <itemId>]');
    const u = await findUpdate(updateId);
    updateId = String(u.id);
    return write(`delete ${u.parentId ? 'reply' : 'update'} ${updateId} on item ${u.item_id}`, { author: u.creator?.name, replies: (u.replies || []).length, text: (u.text_body || '').slice(0, 200) }, async () => {
      await api(`mutation($id:ID!){ delete_update(id:$id){ id } }`, { id: String(updateId) });
      log(`deleted update ${updateId}`);
      return { deleted: String(updateId) };
    });
  },

  async like([updateId]) {
    if (!/^\d+$/.test(String(updateId || ''))) throw new Error('Usage: like <updateId>');
    return write(`like update ${updateId}`, {}, async () => {
      await api(`mutation($id:ID!){ like_update(update_id:$id){ id } }`, { id: String(updateId) });
      log(`liked update ${updateId}`);
      return { liked: String(updateId) };
    });
  },

  async unlike([updateId]) {
    if (!/^\d+$/.test(String(updateId || ''))) throw new Error('Usage: unlike <updateId>');
    return write(`unlike update ${updateId}`, {}, async () => {
      await api(`mutation($id:ID!){ unlike_update(update_id:$id){ id } }`, { id: String(updateId) });
      log(`unliked update ${updateId}`);
      return { unliked: String(updateId) };
    });
  },

  async attach([updateId, ...files]) {
    if (!updateId || !files.length) throw new Error('Usage: attach <updateId> <file> [more...]');
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`No such file: ${missing.join(', ')}`);
    return write(`attach ${files.length} file(s) to update ${updateId}`, { files }, async () => {
      const assets = [];
      for (const f of files) {
        const a = await upload(updateId, f);
        log(`attached ${a.name} (asset ${a.id}) to update ${updateId}`);
        assets.push({ id: String(a.id), name: a.name });
      }
      return { updateId: String(updateId), assets };
    });
  },

  async ['desc-set']([itemId, file]) {
    if (!itemId || !file) throw new Error('Usage: desc-set <itemId> <file.md>');
    const markdown = resolveBody(file);
    return write(`replace the description of ${itemId}`, { markdown: markdown.slice(0, 2000) }, async () => {
      const d = await api(
        `mutation($i:ID!,$md:String!){ set_item_description_content(item_id:$i, markdown:$md){ success error } }`,
        { i: String(itemId), md: markdown }
      );
      const r = d.set_item_description_content;
      log(r.success ? `description updated for ${itemId}` : `FAILED: ${r.error}`);
      return { itemId: String(itemId), ok: !!r.success, error: r.error || null };
    });
  },

  /** Update, then status, estimate, assignee and hook, all validated before the first write. */
  async handoff([itemId, body]) {
    if (!itemId || !FLAGS.to) throw new Error('Usage: handoff <itemId> --to <Name> [--status "<label>"] [--mr <url>]... [--body "<html>|@file"] [--cc A,B] [--estimate <hours>] [--keep-assignees]');
    const cfg = await boardOf(itemId);
    const toId = String(person(FLAGS.to));
    const toName = nameOf(REF.people, toId);
    const label = FLAGS.status || defaultHandoffStatus(cfg);
    if (!label) throw new Error(`No "Ready For QA"-like status on "${cfg.name}"; pass --status "<label>" (or set "handoffStatus" on the board in reference.json).`);
    validStatus(cfg, label);
    const assigneeCol = requireAssigneeColumn(cfg);
    const raw = FLAGS.body ?? body;
    const post = composeBody(handoffBody(raw ? resolveBody(raw) : null, { toName, mrs: FLAGS.mr }));
    const html = withGreeting(post.html, toId, anchor(toId, toName));
    let estimate = null;
    if (FLAGS.estimate !== undefined) {
      const { board, aliases } = await boardColumnsOf(itemId);
      const col = findEstimateColumn(board.columns, aliases);
      estimate = { col, value: columnValue(col, [String(FLAGS.estimate)], person) };
    }
    let assignees = [toId];
    if (FLAGS['keep-assignees']) {
      const cur = await api(`query($i:[ID!]){ items(ids:$i){ column_values(ids:["${assigneeCol}"]){ ... on PeopleValue { persons_and_teams{ id kind } } } } }`, { i: [String(itemId)] });
      const ids = (cur.items[0]?.column_values[0]?.persons_and_teams || []).filter((p) => p.kind === 'person').map((p) => String(p.id));
      assignees = [...new Set([...ids, toId])];
    }
    const runs = hookRuns(REF.hooks?.handoff, { itemId: String(itemId), mrs: FLAGS.mr, to: toName, status: label });
    const plan = {
      update: html,
      mentions: [...new Set([toName, ...post.mentions.map((m) => m.name)])],
      status: label,
      ...(estimate ? { estimate: `${estimate.col.title} = ${estimate.value}` } : {}),
      assignees: assignees.map((id) => nameOf(REF.people, id)),
      links: FLAGS.mr.map((mr) => `task ${itemId} <-> ${mr}`),
      hooks: runs.map((r) => r.join(' ')),
    };
    if (DRY()) return write(`handoff ${itemId} to ${toName}`, plan, null);
    const done = [];
    try {
      const u = await createUpdate(itemId, html);
      done.push(`update ${u.id}`);
      log(`1. update ${u.id} posted as ${u.author}`);
      const values = JSON.parse(statusColumnValues(cfg.statusColumn, label));
      if (estimate) values[estimate.col.id] = estimate.value;
      Object.assign(values, JSON.parse(assigneeColumnValues(assigneeCol, assignees)));
      const texts = await changeColumns(cfg.id, itemId, values);
      done.push('status, estimate and assignee');
      log(`2. status -> ${texts[cfg.statusColumn]}${estimate ? `, ${estimate.col.title} -> ${texts[estimate.col.id]}` : ''}, assignee -> ${texts[assigneeCol]}`);
    } catch (e) {
      throw new Error(`handoff stopped: ${e.message}${done.length ? ` (already done: ${done.join(', ')})` : ' (nothing was changed)'}`);
    }
    const linked = linkMrs(itemId, FLAGS.mr, 'handoff');
    if (linked.length) log(`3. linked ${linked.length} MR(s) to the task in ${linksDbPath()}`);
    const hookResults = runs.map((argv) => {
      try {
        const out = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        log(`4. hook: ${out}`);
        return { argv, ok: true, out };
      } catch (e) {
        log(`4. hook FAILED (${argv.join(' ')}): ${(e.stderr || e.message).toString().trim()}`);
        return { argv, ok: false, error: (e.stderr || e.message).toString().trim() };
      }
    });
    log('--- read back ---');
    const after = await cmds.get([itemId]);
    return { ...plan, hookResults, item: after };
  },

  async insights([boardId]) {
    if (!boardId) throw new Error('Usage: insights <boardId> [--by "<column>"]');
    const board = await boardColumns(boardId);
    const cfg = REF.boards[String(boardId)] || {};
    const col = FLAGS.by ? findColumn(board.columns, FLAGS.by, cfg.aliases || {}) : board.columns.find((c) => c.id === cfg.statusColumn) || findColumn(board.columns, 'status');
    const res = await mcp().call('board_insights', { boardId: Number(boardId), aggregations: [{ columnId: col.id }, { function: 'COUNT_ITEMS' }], groupBy: [col.id], limit: 1000 });
    const rows = (res.data || []).map((r) => {
      const count = Number(Object.entries(r).find(([k]) => k.startsWith('COUNT_ITEMS'))?.[1] || 0);
      const labelKey = Object.keys(r).find((k) => /^(LABEL|PERSON|NAME|TEXT)_/.test(k));
      const value = labelKey ? r[labelKey] : r[col.id];
      return { value: value === null || value === undefined || value === '' ? '(empty)' : String(value), count };
    }).sort((a, b) => b.count - a.count);
    log(`${board.name}: items by ${col.title}`);
    rows.forEach((r) => log(`  ${String(r.count).padStart(5)}  ${r.value}`));
    return { board: board.name, column: col.title, rows };
  },

  async automations([boardId]) {
    if (!boardId) throw new Error('Usage: automations <boardId>');
    const res = await mcp().call('list_automations', { boardId: String(boardId), limit: 100 });
    const rows = (res.workflows || []).map((w) => ({
      id: String(w.id), active: !!(w.is_active ?? w.active), steps: (w.workflow_blocks || []).map((b) => b.title),
    }));
    rows.sort((a, b) => Number(b.active) - Number(a.active));
    rows.forEach((r) => log(`  ${r.active ? 'ON ' : 'off'}  ${r.id}  ${r.steps.join(', then ')}`));
    log(`${rows.filter((r) => r.active).length} active of ${rows.length}`);
    return rows;
  },

  async meetings([query]) {
    if (FLAGS.id) {
      const res = await mcp().call('get_meetings_content', {
        ids: [String(FLAGS.id)], include_summary: true, include_topics: true, include_action_items: true, include_transcript: !!FLAGS.transcript,
      });
      log(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
      return res;
    }
    const args = { limit: Number(FLAGS.limit || 10) };
    if (query) args.query = query;
    if (FLAGS.since) args.start_time_from = new Date(FLAGS.since).toISOString();
    if (FLAGS.until) args.start_time_to = new Date(FLAGS.until).toISOString();
    const res = await mcp().call('explore_meetings', args);
    log(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
    return res;
  },

  async mcp([tool, argJson]) {
    if (!tool) throw new Error("Usage: mcp tools [filter]  |  mcp <tool> ['<json>'|@file] [--write]");
    const tools = await mcp().tools();
    if (tool === 'tools') {
      const lc = (argJson || '').toLowerCase();
      const rows = tools.filter((t) => t.name.includes(lc)).map((t) => ({ name: t.name, readOnly: isReadOnlyTool(t), about: (t.description || '').split('\n')[0].slice(0, 100) }));
      rows.forEach((r) => log(`  ${r.readOnly ? 'RO' : 'W '}  ${r.name.padEnd(30)} ${r.about}`));
      return rows;
    }
    const def = tools.find((t) => t.name === tool);
    if (!def) throw new Error(`No MCP tool "${tool}". List them with:  mon.js mcp tools`);
    if (NEVER_PASSTHROUGH.has(tool)) throw new Error(`${tool} sends feedback to monday staff; mon.js won't call it.`);
    const args = argJson ? JSON.parse(resolveBody(argJson)) : {};
    if (!isReadOnlyTool(def) && !FLAGS.write) {
      throw new Error(`${tool} changes data in monday (it acts as you). Add --write to run it, after a --dry-run. Post updates with  mon.js update  instead of create_update, which adds a duplicate mentions footer.`);
    }
    const run = async () => {
      const res = await mcp().call(tool, args);
      log(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
      return res;
    };
    return isReadOnlyTool(def) ? run() : write(`call MCP tool ${tool}`, { arguments: args }, run);
  },

  /** Which sessions, monday items and MRs belong to the same task. Local data only; no monday writes. */
  async links([sub, ...rest]) {
    const store = links();
    try {
      if (sub === 'import') {
        const days = Number(FLAGS.days || 180);
        const r = importTranscripts(store, Date.now() - days * 86400000);
        log(`imported ${r.sessions} session(s), ${r.mrs} created MR(s) from the last ${days} days of transcripts into ${linksDbPath()}`);
        return r;
      }
      if (sub === 'add') {
        const [itemId] = rest;
        if (!/^\d+$/.test(itemId || '') || !(FLAGS.mr.length || FLAGS.session || FLAGS.branch)) {
          throw new Error('Usage: links add <itemId> [--mr <url>]... [--session <id>] [--branch <b> --repo <r>]');
        }
        if (FLAGS.session) store.linkTaskSession(itemId, FLAGS.session, 'manual');
        if (FLAGS.branch) {
          const repo = FLAGS.repo || require('./lib/transcripts').checkoutOf(process.cwd()).repo;
          if (!repo) throw new Error('--branch needs --repo <name> (or run it inside that repo).');
          if (require('./lib/links').MAIN_BRANCHES.has(FLAGS.branch)) throw new Error(`${FLAGS.branch} is a main branch; link the task's own branch.`);
          store.linkTaskBranch(itemId, repo, FLAGS.branch, 'manual');
        }
        store.close();
        const mrs = linkMrs(itemId, FLAGS.mr, 'manual');
        log(`linked task ${itemId}: ${[...mrs.map((m) => m.url + (m.branch ? ` (${m.branch})` : '')), FLAGS.session, FLAGS.branch].filter(Boolean).join(', ')}`);
        return { itemId: String(itemId), mrs, session: FLAGS.session || null, branch: FLAGS.branch || null };
      }
      const item = sub && /^\d+$/.test(sub) ? sub : FLAGS.item;
      const mr = sub && /^https?:\/\//.test(sub) ? sub : FLAGS.mr[0];
      if (!item && !mr && !FLAGS.session && !FLAGS.branch) {
        throw new Error('Usage: links (<itemId> | <mrUrl> | --item <id> | --mr <url> | --session <id> | --branch <b> [--repo <r>])  |  links add ...  |  links import [--days N]');
      }
      const r = store.resolve({ item, mr, session: FLAGS.session, branch: FLAGS.branch, repo: FLAGS.repo });
      const names = {};
      if (r.items.length && api && !FLAGS['no-names']) {
        try {
          (await api(`query($i:[ID!]){ items(ids:$i){ id name } }`, { i: r.items })).items.forEach((it) => { names[it.id] = it.name; });
        } catch { /* names are a convenience; the links are local */ }
      }
      printLinks(r, names);
      return { ...r, items: r.items.map((id) => ({ id, name: names[id] ?? null })) };
    } finally {
      try { store.close(); } catch { /* already closed */ }
    }
  },

  /**
   * Reopen a task's Claude session: the best match from the links, resumed from its own directory,
   * else (or with --new) a new session named monday_<id> with the task link (--url) typed into its input,
   * unsent. On a terminal it starts claude; otherwise (or with --print) it prints the command.
   */
  async resume([itemId]) {
    if (!/^\d+$/.test(itemId || '')) throw new Error('Usage: resume <itemId> [--new] [--url <taskUrl>] [--print]');
    const store = links();
    let best;
    try {
      best = store.resolve({ item: itemId }).sessions.find((s) => s.cwd && s.transcript && fs.existsSync(s.transcript) && fs.existsSync(s.cwd));
    } finally {
      store.close();
    }
    if (FLAGS.new) best = undefined;
    const [cwd, args] = best ? [best.cwd, ['--resume', best.id]] : [process.cwd(), ['--name', `monday_${itemId}`]];
    const command = `cd ${JSON.stringify(cwd)} && claude ${args.join(' ')}`;
    log(best ? `task ${itemId}: ${best.title || best.id} [${best.how.join('; ')}]` : `task ${itemId}: ${FLAGS.new ? 'new session' : 'no earlier session'}, starting one named monday_${itemId}`);
    if (FLAGS.print || JSON_OUT || !process.stdin.isTTY) {
      log(command);
      return { itemId: String(itemId), session: best?.id ?? null, command };
    }
    if (!best) typeAhead(`monday task ${FLAGS.url || itemId} `);
    const r = require('child_process').spawnSync('claude', args, { cwd, stdio: 'inherit' });
    if (r.error) throw new Error(`Couldn't start claude (${r.error.message}). Run it yourself: ${command}`);
    return { itemId: String(itemId), session: best?.id ?? null, exitCode: r.status };
  },

  async labels([boardId]) {
    const ids = boardId ? [String(boardId)] : Object.keys(REF.boards);
    if (!ids.length) throw new Error('Nothing configured yet. Run:  mon.js init <boardId> [more...]');
    const out = {};
    ids.forEach((id) => {
      const b = REF.boards[id];
      if (!b) { log(`[${id}] not configured`); return; }
      log(`[${b.name}: ${id}]`);
      const labels = Object.keys(b.statusLabels);
      labels.forEach((l) => log('  ' + l));
      out[id] = { name: b.name, labels };
    });
    return out;
  },
};

// ---- entry ----------------------------------------------------------------

function printHelp() {
  const doc = fs.readFileSync(__filename, 'utf8');
  const block = doc.slice(doc.indexOf(' * Commands:'), doc.indexOf(' * The token acts'));
  console.log('mon.js <command> [args] [--json] [--dry-run]\n');
  console.log(block.replace(/^ \* ?/gm, '').trim());
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { printHelp(); process.exit(cmd ? 0 : 1); }
  if (!cmds[cmd]) { console.error(`Unknown command "${cmd}". Try:  mon.js help`); process.exit(1); }
  let positional;
  try {
    ({ positional, flags: FLAGS } = parseArgs(rest));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  JSON_OUT = !!FLAGS.json;
  bootConfig();
  if (cmd === 'setup') {
    // setup gets the token itself
  } else if (cmd === 'links' || cmd === 'resume') {
    // local data; the token only adds task names
    if (resolveToken({ env: process.env[REF.tokenEnvVar], saved: readSavedToken() })) requireToken();
  } else if (cmd !== 'login' && cmd !== 'logout') {
    requireToken();
  }
  try {
    const result = await cmds[cmd](positional);
    if (JSON_OUT) console.log(JSON.stringify(result ?? null, null, 2));
  } catch (e) {
    if (JSON_OUT) console.log(JSON.stringify({ error: e.message }, null, 2));
    else console.error(e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  normalize, labelsFromSettings, blocksToMarkdown, detectColumn, resolvePerson,
  statusColumnValues, assigneeColumnValues, nextDelay, createClient, resolveToken,
  resolveBody, writeFileAtomic, parseArgs, pickBoards, isDoneStatus, unansweredMentions, describeActivity,
  handoffBody, withGreeting, defaultHandoffStatus, hookRuns, htmlToText, cmds, setRuntime,
};
