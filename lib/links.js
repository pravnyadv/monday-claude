/**
 * The session links store (links.db, node:sqlite): which Claude Code sessions, monday items and
 * merge requests belong to the same piece of work. The hook (hooks/links-hook.js) fills it as you
 * work, `mon.js links import` backfills it from old transcripts, and `mon.js links` answers
 * "which sessions/MRs belong to this task" (and the reverse) for people and for tools such as
 * mr-rebase-bot.
 *
 * Edges, each recorded with how it was learned (`source`):
 *   task_sessions   item  <-> session   (item named in a prompt, session named monday_<id>, by hand)
 *   task_mrs        item  <-> MR        (MR created in a session working that item, handoff, by hand)
 *   task_branches   item  <-> repo:branch  (item named while working on that branch)
 *   session_mrs     session <-> MR      (created it, or mentioned it)
 *   session_branches session <-> repo:branch (every hook event; counts how much work happened there)
 *   mrs             MR -> repo, branch
 */
const fs = require('fs');
const path = require('path');

const MAIN_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop']);

/** Monday item ids in free text: pulse URLs, `monday_<id>` names, "monday item <id>". */
const ITEM_ID = /(?:pulses\/|monday(?:[ _#:-]|\s+item\s+|\s+task\s+)*)(\d{9,12})(?!\d)/gi;
/** GitLab merge request and GitHub pull request URLs. */
const MR_URL = /https?:\/\/[^\s"'<>)\]\\]+?\/(?:-\/merge_requests|pull)\/\d+/g;

const itemIdsIn = (text) => [...new Set([...String(text || '').matchAll(ITEM_ID)].map((m) => m[1]))];
const mrUrlsIn = (text) => [...new Set(String(text || '').match(MR_URL) || [])];

/** repo name and project path from an MR URL (GitLab `group/repo/-/merge_requests/N`, GitHub `owner/repo/pull/N`). */
function mrRepo(url) {
  const m = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/merge_requests|pull)\/\d+/.exec(url);
  return m ? m[1].split('/').pop() : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, transcript TEXT, cwd TEXT, title TEXT, first_at TEXT, last_at TEXT);
CREATE TABLE IF NOT EXISTS session_branches (session TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, cwd TEXT, events INTEGER NOT NULL DEFAULT 0, first_at TEXT, last_at TEXT, PRIMARY KEY (session, repo, branch));
CREATE TABLE IF NOT EXISTS mrs (url TEXT PRIMARY KEY, repo TEXT, branch TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS task_sessions (item_id TEXT NOT NULL, session TEXT NOT NULL, source TEXT, at TEXT, PRIMARY KEY (item_id, session));
CREATE TABLE IF NOT EXISTS task_mrs (item_id TEXT NOT NULL, mr_url TEXT NOT NULL, source TEXT, at TEXT, PRIMARY KEY (item_id, mr_url));
CREATE TABLE IF NOT EXISTS task_branches (item_id TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, source TEXT, at TEXT, PRIMARY KEY (item_id, repo, branch));
CREATE TABLE IF NOT EXISTS session_mrs (session TEXT NOT NULL, mr_url TEXT NOT NULL, source TEXT, at TEXT, PRIMARY KEY (session, mr_url));
CREATE INDEX IF NOT EXISTS session_branches_branch ON session_branches(repo, branch);
CREATE INDEX IF NOT EXISTS task_sessions_session ON task_sessions(session);
CREATE INDEX IF NOT EXISTS task_mrs_mr ON task_mrs(mr_url);
CREATE INDEX IF NOT EXISTS session_mrs_mr ON session_mrs(mr_url);
`;

/** Stronger evidence first: how a session is tied to the task decides which one a tool should pick. */
const HOW_RANK = { 'created the MR': 0, 'worked on the MR branch': 1, 'named for the task': 2, 'linked by hand': 2, 'named the task in a prompt': 3, 'mentioned the MR': 4 };

function openLinks(file) {
  process.removeAllListeners('warning');
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  const now = () => new Date().toISOString();
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  const store = {
    db,

    touchSession({ id, transcript = null, cwd = null, at = now() }) {
      db.prepare(`INSERT INTO sessions (id, transcript, cwd, first_at, last_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET transcript = COALESCE(excluded.transcript, transcript), cwd = COALESCE(cwd, excluded.cwd),
        first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`).run(id, transcript, cwd, at, at);
    },

    /** Count work on a branch. `replace` (imports) keeps the larger count instead of adding, so re-imports don't inflate it. */
    touchBranch({ session, repo, branch, cwd = null, at = now(), events = 1, replace = false }) {
      if (!repo || !branch) return;
      db.prepare(`INSERT INTO session_branches (session, repo, branch, cwd, events, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session, repo, branch) DO UPDATE SET events = ${replace ? 'MAX(events, excluded.events)' : 'events + excluded.events'}, cwd = COALESCE(excluded.cwd, cwd),
        first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`).run(session, repo, branch, cwd, events, at, at);
    },

    /** Store a title and link the items it names (a session called monday_<id> is that task's). */
    setTitle(session, title) {
      if (!title) return;
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, session);
      const bare = String(title).match(/(?<!\d)1\d{10}(?!\d)/g) || [];
      new Set([...itemIdsIn(title), ...bare]).forEach((item) => store.linkTaskSession(item, session, 'title'));
    },

    linkTaskSession(item, session, source, at = now()) {
      // a session title or a hand link is stronger evidence than a prompt mention, so it wins
      db.prepare(`INSERT INTO task_sessions VALUES (?, ?, ?, ?) ON CONFLICT(item_id, session) DO UPDATE SET at = MAX(at, excluded.at),
        source = CASE WHEN excluded.source IN ('title', 'manual') THEN excluded.source ELSE source END`).run(String(item), session, source, at);
    },

    linkTaskBranch(item, repo, branch, source, at = now()) {
      if (!repo || !branch || MAIN_BRANCHES.has(branch)) return;
      db.prepare('INSERT OR IGNORE INTO task_branches VALUES (?, ?, ?, ?, ?)').run(String(item), repo, branch, source, at);
    },

    /** An MR's branch comes from its earliest creation (`createdAt`) or the first source that knew it; later guesses never overwrite it. */
    addMr({ url, repo = mrRepo(url), branch = null, createdAt = null }) {
      db.prepare(`INSERT INTO mrs VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET repo = COALESCE(repo, excluded.repo),
        branch = CASE WHEN excluded.created_at IS NOT NULL AND (created_at IS NULL OR excluded.created_at < created_at) AND excluded.branch IS NOT NULL
          THEN excluded.branch ELSE COALESCE(branch, excluded.branch) END,
        created_at = CASE WHEN excluded.created_at IS NOT NULL AND (created_at IS NULL OR excluded.created_at < created_at) THEN excluded.created_at ELSE created_at END`).run(url, repo, branch, createdAt);
    },

    linkTaskMr(item, url, source, at = now()) {
      store.addMr({ url });
      db.prepare('INSERT OR IGNORE INTO task_mrs VALUES (?, ?, ?, ?)').run(String(item), url, source, at);
    },

    linkSessionMr(session, url, source, at = now()) {
      store.addMr({ url });
      // "created" outranks a later "mentioned" for the same pair
      db.prepare(`INSERT INTO session_mrs VALUES (?, ?, ?, ?) ON CONFLICT(session, mr_url) DO UPDATE SET source = CASE WHEN excluded.source = 'created' THEN 'created' ELSE source END`).run(session, url, source, at);
    },

    /**
     * The items an MR created in `session` belongs to: ids named in the create command (the
     * description links the task), else the session's most recently named item.
     */
    itemsForNewMr(session, commandText) {
      const named = itemIdsIn(commandText);
      if (named.length) return named;
      const latest = db.prepare('SELECT item_id FROM task_sessions WHERE session = ? ORDER BY at DESC LIMIT 1').get(session);
      return latest ? [latest.item_id] : [];
    },

    /**
     * Record an MR a session just created and tie it to the task. The host's answer wins: its source
     * branch, and the task linked first in its description; a description the host returned without
     * a task link means the MR has no task. Only when the host can't be asked does the session's
     * latest task (or `items`) stand in. The repo comes from the MR URL, which can't be wrong, before
     * the directory the command ran in, which can (a `cd` mid-command).
     */
    recordCreatedMr({ session, url, repo, branch, commandText, at = now(), items = null, info = mrInfo(url) }) {
      branch = info?.branch || branch;
      repo = mrRepo(url) || repo;
      store.addMr({ url, repo, branch, createdAt: at });
      store.linkSessionMr(session, url, 'created', at);
      const described = itemIdsIn(info?.description).slice(0, 1);
      const guessed = info ? [] : items || store.itemsForNewMr(session, commandText);
      for (const item of described.length ? described : guessed) {
        store.linkTaskMr(item, url, described.length ? 'linked in the MR description' : 'created in a session on the task', at);
        if (branch) store.linkTaskBranch(item, repo, branch, 'mr', at);
      }
    },

    /** Everything tied to one item, MR, session or branch: the whole task it belongs to. */
    resolve({ item, mr, session, branch, repo }) {
      const items = new Set(item ? [String(item)] : []);
      const mrs = new Set(mr ? [mr] : []);
      const branches = new Map();
      const addBranch = (r, b) => { if (r && b && !MAIN_BRANCHES.has(b)) branches.set(`${r}:${b}`, { repo: r, branch: b }); };
      if (mr) {
        all('SELECT item_id FROM task_mrs WHERE mr_url = ?', mr).forEach((r) => items.add(r.item_id));
        const m = db.prepare('SELECT repo, branch FROM mrs WHERE url = ?').get(mr);
        if (m) addBranch(m.repo, m.branch);
      }
      if (session) {
        all('SELECT item_id FROM task_sessions WHERE session = ?', session).forEach((r) => items.add(r.item_id));
        all('SELECT mr_url FROM session_mrs WHERE session = ? AND source = ?', session, 'created').forEach((r) => mrs.add(r.mr_url));
      }
      if (branch) {
        addBranch(repo || null, branch);
        all(`SELECT item_id FROM task_branches WHERE branch = ? ${repo ? 'AND repo = ?' : ''}`, ...[branch, repo].filter(Boolean)).forEach((r) => items.add(r.item_id));
        all(`SELECT url FROM mrs WHERE branch = ? ${repo ? 'AND repo = ?' : ''}`, ...[branch, repo].filter(Boolean)).forEach((r) => mrs.add(r.url));
        if (!repo) all('SELECT DISTINCT repo FROM session_branches WHERE branch = ?', branch).forEach((r) => addBranch(r.repo, branch));
      }
      for (const id of items) {
        all('SELECT mr_url FROM task_mrs WHERE item_id = ?', id).forEach((r) => mrs.add(r.mr_url));
        all('SELECT repo, branch FROM task_branches WHERE item_id = ?', id).forEach((r) => addBranch(r.repo, r.branch));
      }
      for (const url of mrs) {
        const m = db.prepare('SELECT repo, branch FROM mrs WHERE url = ?').get(url);
        if (m) addBranch(m.repo, m.branch);
        all('SELECT item_id FROM task_mrs WHERE mr_url = ?', url).forEach((r) => items.add(r.item_id));
      }

      const found = new Map();
      const tie = (id, how, branchEvents = 0) => {
        const s = found.get(id) || { how: new Set(), branchEvents: 0 };
        s.how.add(how);
        s.branchEvents += branchEvents;
        found.set(id, s);
      };
      for (const url of mrs) {
        all('SELECT session, source FROM session_mrs WHERE mr_url = ?', url).forEach((r) => tie(r.session, r.source === 'created' ? 'created the MR' : 'mentioned the MR'));
      }
      for (const b of branches.values()) {
        all('SELECT session, events FROM session_branches WHERE repo = ? AND branch = ?', b.repo, b.branch).forEach((r) => tie(r.session, 'worked on the MR branch', Number(r.events)));
      }
      for (const id of items) {
        all('SELECT session, source FROM task_sessions WHERE item_id = ?', id).forEach((r) => tie(r.session, r.source === 'title' ? 'named for the task' : r.source === 'manual' ? 'linked by hand' : 'named the task in a prompt'));
      }
      if (session) tie(session, 'asked about');

      const rank = (s) => Math.min(...[...s.how].map((h) => HOW_RANK[h] ?? 9));
      const sessions = [...found.entries()].map(([id, s]) => {
        const row = db.prepare('SELECT transcript, cwd, title, first_at, last_at FROM sessions WHERE id = ?').get(id) || {};
        return {
          id, title: row.title ?? null, cwd: row.cwd ?? null, transcript: row.transcript ?? null,
          how: [...s.how].sort((a, b) => (HOW_RANK[a] ?? 9) - (HOW_RANK[b] ?? 9)), branchEvents: s.branchEvents,
          firstAt: row.first_at ?? null, lastAt: row.last_at ?? null, _rank: rank(s),
        };
      }).sort((a, b) => a._rank - b._rank || b.branchEvents - a.branchEvents || String(b.lastAt).localeCompare(String(a.lastAt)))
        .map(({ _rank, ...s }) => s);

      return {
        items: [...items],
        mrs: [...mrs].map((url) => ({ url, ...(db.prepare('SELECT repo, branch FROM mrs WHERE url = ?').get(url) || {}) })),
        branches: [...branches.values()],
        sessions,
      };
    },

    /** session -> item ids, through every edge (for time accounting: whose minutes go to which task). */
    itemsBySession() {
      const out = new Map();
      const add = (s, i) => out.set(s, new Set([...(out.get(s) || []), i]));
      all('SELECT session, item_id FROM task_sessions').forEach((r) => add(r.session, r.item_id));
      all(`SELECT sb.session, tb.item_id FROM session_branches sb JOIN task_branches tb ON tb.repo = sb.repo AND tb.branch = sb.branch`).forEach((r) => add(r.session, r.item_id));
      all(`SELECT sb.session, tm.item_id FROM session_branches sb JOIN mrs m ON m.repo = sb.repo AND m.branch = sb.branch JOIN task_mrs tm ON tm.mr_url = m.url`).forEach((r) => add(r.session, r.item_id));
      return new Map([...out].map(([s, set]) => [s, [...set]]));
    },

    mrsOfItem(item) {
      return all('SELECT tm.mr_url url, m.repo, m.branch FROM task_mrs tm LEFT JOIN mrs m ON m.url = tm.mr_url WHERE tm.item_id = ?', String(item));
    },

    close() { db.close(); },
  };
  return store;
}

const mrInfoCache = new Map();
/**
 * An MR's source branch and description from its host (glab for GitLab, gh for GitHub), or null
 * when the CLI isn't there or can't see it. The description's task link is the strongest evidence
 * of which task an MR belongs to.
 */
function mrInfo(url) {
  if (mrInfoCache.has(url)) return mrInfoCache.get(url);
  const { execFileSync } = require('child_process');
  const run = (cmd, args) => JSON.parse(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }));
  let info = null;
  try {
    const gl = /^https?:\/\/([^/]+)\/(.+)\/-\/merge_requests\/(\d+)/.exec(url);
    if (gl) {
      const j = run('glab', ['mr', 'view', gl[3], '-R', `${gl[1]}/${gl[2]}`, '-F', 'json']);
      info = { branch: j.source_branch || null, description: j.description || '' };
    } else if (/\/pull\/\d+/.test(url)) {
      const j = run('gh', ['pr', 'view', url, '--json', 'headRefName,body']);
      info = { branch: j.headRefName || null, description: j.body || '' };
    }
  } catch {
    info = null;
  }
  mrInfoCache.set(url, info);
  return info;
}

module.exports = { mrInfo, openLinks, itemIdsIn, mrUrlsIn, mrRepo, MAIN_BRANCHES, HOW_RANK };
