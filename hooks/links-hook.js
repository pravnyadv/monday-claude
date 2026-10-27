#!/usr/bin/env node
/**
 * Claude Code hook: records which session, monday items and MRs belong together, in links.db (see
 * lib/links.js). Register it on UserPromptSubmit, Stop and PostToolUse (Edit|Write|NotebookEdit|Bash),
 * async, and on SessionStart (not async). It reads the hook payload on stdin and never fails the session.
 *
 * Its only output: on SessionStart (startup, resume, fork) of a session with no custom title that the
 * links tie to exactly one monday item, it names it monday_<id>, the same as /rename. Set
 * MONDAY_LINKS_AUTONAME=0 to turn that off. Stores ids, branches and MR URLs only, never prompt text.
 */
const path = require('path');
const { openLinks, itemIdsIn, mrUrlsIn } = require('../lib/links');
const { linksDbPath } = require('../lib/paths');
const { createsMr, isAutomated, checkoutOf, commandDir, commandSourceBranch, transcriptTitle } = require('../lib/transcripts');

function record(p) {
  const session = p.session_id;
  const cwd = p.cwd || process.cwd();
  if (!session || isAutomated(cwd)) return;
  const input = p.tool_input || {};
  // an edit says where the work happened, which can be a worktree other than where the session started
  const edited = input.file_path || input.notebook_path;
  const workDir = edited ? path.dirname(edited) : p.tool_name === 'Bash' ? commandDir(input.command, cwd) : cwd;
  const { repo, branch } = checkoutOf(workDir);
  const links = openLinks(linksDbPath());
  try {
    links.touchSession({ id: session, transcript: p.transcript_path || null, cwd });
    links.touchBranch({ session, repo, branch, cwd: workDir });
    if (p.hook_event_name === 'UserPromptSubmit') {
      for (const item of itemIdsIn(p.prompt)) {
        links.linkTaskSession(item, session, 'prompt');
        links.linkTaskBranch(item, repo, branch, 'prompt');
      }
      mrUrlsIn(p.prompt).forEach((url) => links.linkSessionMr(session, url, 'mentioned'));
    }
    if (p.tool_name === 'Bash' && createsMr(input.command)) {
      for (const url of mrUrlsIn(JSON.stringify(p.tool_response ?? ''))) {
        links.recordCreatedMr({ session, url, repo, branch: commandSourceBranch(input.command) || branch, commandText: input.command });
      }
    }
    if (p.hook_event_name === 'SessionStart') return sessionTitle(links, p);
    if (p.hook_event_name === 'Stop' && p.transcript_path) {
      const known = links.db.prepare('SELECT title FROM sessions WHERE id = ?').get(session)?.title;
      links.setTitle(session, transcriptTitle(p.transcript_path, { full: !known }));
    }
  } finally {
    links.close();
  }
}

/** The monday_<id> name for an untitled session that belongs to exactly one task, or nothing. */
function sessionTitle(links, p) {
  if (process.env.MONDAY_LINKS_AUTONAME === '0' || p.session_title || !['startup', 'resume', 'fork'].includes(p.source)) return null;
  // also trust the title the Stop hook read from the transcript, in case the payload ever lacks session_title
  if (links.db.prepare('SELECT title FROM sessions WHERE id = ?').get(p.session_id)?.title) return null;
  const items = links.resolve({ session: p.session_id }).items;
  return items.length === 1 ? { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `monday_${items[0]}` } } : null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const out = record(JSON.parse(raw));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    if (process.env.MONDAY_LINKS_DEBUG) console.error(e);
  }
});
