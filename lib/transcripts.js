/**
 * Reading Claude Code's own records: transcripts under ~/.claude/projects and the git checkout a
 * session worked in. Shared by the live hook and `mon.js links import`, so both learn the same facts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects');

/** Sessions the mr-rebase-bot runs itself (its own worktrees, or anything it spawns with MR_REBASE_BOT set). */
const isAutomated = (cwd) => !!process.env.MR_REBASE_BOT || /[/\\]_mr-rebase-bot(?:[/\\]|$)/.test(cwd || '');

const CREATE_SEGMENT = /^\s*(?:\w+=\S*\s+)*(?:glab\s+mr\s+create\b|gh\s+pr\s+create\b|glab\s+api\b(?=.*-X\s*POST)(?=.*merge_requests(?![/\w])))/i;

/**
 * Whether a shell command creates an MR/PR: one of its `&&`/`;`/`|` segments starts with glab or gh
 * creating one. A command that only quotes "glab mr create" (a test, a grep) doesn't count.
 */
const createsMr = (command) => String(command || '').split(/&&|\|\||;|\||\n/).some((seg) => CREATE_SEGMENT.test(seg));

const git = (dir, args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
};

const checkoutCache = new Map();
/** { repo, branch } of the checkout holding `dir`; worktrees resolve to their repo's name. */
function checkoutOf(dir) {
  if (!dir) return { repo: null, branch: null };
  let d = dir;
  while (d && !fs.existsSync(d)) d = path.dirname(d);
  if (!checkoutCache.has(d)) {
    const common = git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    checkoutCache.set(d, { repo: common ? path.basename(path.dirname(common)) : null, branch: git(d, ['rev-parse', '--abbrev-ref', 'HEAD']) });
  }
  return checkoutCache.get(d);
}

/** The directory a shell command ran in: a leading `cd <dir> &&` or `git -C <dir>`, else the session cwd. */
function commandDir(command, cwd) {
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(command || '') || /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command || '');
  if (!m) return cwd;
  const dir = m[1].replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(dir) ? dir : path.resolve(cwd || '.', dir);
}

/** An explicit source branch in an MR/PR create command (`--source-branch`, `-s`, `--head`). */
function commandSourceBranch(command) {
  return /(?:--source-branch|--head|\s-s)[\s=]+("[^"]+"|'[^']+'|[^\s]+)/.exec(command || '')?.[1]?.replace(/^["']|["']$/g, '') || null;
}

/** The last /rename title in a transcript. Reads the tail first; a full read only when the tail has none. */
function transcriptTitle(file, { full = false } = {}) {
  try {
    const size = fs.statSync(file).size;
    const read = (from) => {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      return buf.toString('utf8');
    };
    const last = (text) => [...text.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).pop() || null;
    return last(read(Math.max(0, size - 2 * 1024 * 1024))) || (full && size > 2 * 1024 * 1024 ? last(read(0)) : null);
  } catch {
    return null;
  }
}

function promptText(entry) {
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
}

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n') : '');

/** Every transcript file, newest first, optionally only those touched since `sinceMs`. */
function transcriptFiles(sinceMs = 0) {
  if (!fs.existsSync(TRANSCRIPTS)) return [];
  return fs.readdirSync(TRANSCRIPTS).flatMap((dir) => {
    const full = path.join(TRANSCRIPTS, dir);
    return fs.statSync(full).isDirectory() ? fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(full, f)) : [];
  }).map((f) => ({ f, m: fs.statSync(f).mtimeMs })).filter((x) => x.m >= sinceMs).sort((a, b) => b.m - a.m).map((x) => x.f);
}

/**
 * The facts one transcript holds, in order: where the session ran, prompts (for task ids and MR
 * links), files it edited, and MRs it created (a create command whose result prints the URL).
 */
function readTranscript(file) {
  const facts = { session: path.basename(file, '.jsonl'), cwd: null, title: null, first: null, last: null, prompts: [], edits: [], createdMrs: [], branchEvents: new Map() };
  const pending = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e;
    try { e = line ? JSON.parse(line) : null; } catch { e = null; }
    if (!e) continue;
    if (e.customTitle) facts.title = e.customTitle;
    if (!e.timestamp) continue;
    facts.cwd ??= e.cwd || null;
    facts.first ??= e.timestamp;
    facts.last = e.timestamp;
    if (e.cwd && e.gitBranch) {
      const key = `${e.cwd}\u0000${e.gitBranch}`;
      facts.branchEvents.set(key, (facts.branchEvents.get(key) || 0) + 1);
    }
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'user' && !e.isMeta) {
      const text = promptText(e);
      if (text && !text.startsWith('<')) facts.prompts.push({ at: e.timestamp, text, cwd: e.cwd, branch: e.gitBranch });
      for (const c of content.filter((x) => x?.type === 'tool_result' && pending.has(x.tool_use_id))) {
        facts.createdMrs.push({ ...pending.get(c.tool_use_id), at: e.timestamp, output: resultText(c.content) });
        pending.delete(c.tool_use_id);
      }
    }
    for (const c of content.filter((x) => x?.type === 'tool_use')) {
      if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(c.name) && c.input?.file_path) facts.edits.push({ at: e.timestamp, file: c.input.file_path });
      if (c.name === 'Bash' && createsMr(c.input?.command)) pending.set(c.id, { command: c.input.command, cwd: e.cwd });
    }
  }
  return facts;
}

module.exports = { TRANSCRIPTS, createsMr, isAutomated, checkoutOf, commandDir, commandSourceBranch, transcriptTitle, readTranscript, transcriptFiles };
