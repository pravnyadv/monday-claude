/**
 * Edits to the user's Claude Code settings (~/.claude/settings.json) that `mon.js setup` offers:
 * registering the session-links hook and keeping transcripts long enough to resume old sessions.
 * Merges into what is there, never replaces it, and keeps a .bak of the previous file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
/**
 * The events the hook needs: prompts (task ids, MR links), stops (session names), edits and shell calls
 * (branches, created MRs), and SessionStart, which names an untitled task session monday_<id> and so must
 * not be async: its output is read.
 */
const HOOK_EVENTS = [['UserPromptSubmit', null], ['Stop', null], ['PostToolUse', 'Edit|Write|NotebookEdit|Bash'], ['SessionStart', null]];

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e.message}); fix it first, nothing was changed.`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const hookCommand = (hookFile) => `node "${hookFile}"`;

/** Whether every event already runs a links-hook.js (any path, so a moved clone isn't registered twice). */
function hasLinksHook(settings) {
  return HOOK_EVENTS.every(([event]) => (settings.hooks?.[event] || []).some((g) => (g.hooks || []).some((h) => /links-hook\.js/.test(h.command || ''))));
}

/** Settings with the hook added to each event that lacks it. Pure. */
function withLinksHook(settings, hookFile) {
  const out = { ...settings, hooks: { ...(settings.hooks || {}) } };
  for (const [event, matcher] of HOOK_EVENTS) {
    const groups = [...(out.hooks[event] || [])];
    if (!groups.some((g) => (g.hooks || []).some((h) => /links-hook\.js/.test(h.command || '')))) {
      const hook = event === 'SessionStart' ? { type: 'command', command: hookCommand(hookFile), timeout: 5 } : { type: 'command', command: hookCommand(hookFile), async: true, timeout: 10 };
      groups.push({ ...(matcher ? { matcher } : { matcher: '' }), hooks: [hook] });
    }
    out.hooks[event] = groups;
  }
  return out;
}

module.exports = { SETTINGS, readSettings, writeSettings, hasLinksHook, withLinksHook, hookCommand };
