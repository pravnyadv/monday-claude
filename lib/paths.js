/**
 * Where mon.js keeps its per-account files. Shared by the CLI and the session-links hook, which runs
 * as a separate process and must find the same files.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** reference.json: explicit override, else a script-local file (existing setups), else XDG. */
function refPath() {
  if (process.env.MONDAY_CLAUDE_CONFIG) return process.env.MONDAY_CLAUDE_CONFIG;
  const local = path.join(__dirname, '..', 'reference.json');
  if (fs.existsSync(local)) return local;
  const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(home, 'monday-claude', 'reference.json');
}

/** The session/task/MR link store, next to reference.json unless MONDAY_LINKS_DB says otherwise. */
function linksDbPath() {
  return process.env.MONDAY_LINKS_DB || path.join(path.dirname(refPath()), 'links.db');
}

module.exports = { refPath, linksDbPath };
