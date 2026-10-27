#!/usr/bin/env bash
# Install the monday-tasks skill for Claude Code from a cloned checkout (the non-plugin route).
# It copies the skill into ~/.claude/skills and rewrites the bundled-CLI path to point at this clone.
set -euo pipefail

CLONE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/skills/monday-tasks"

mkdir -p "$DEST"
# The skill references the CLI as "$CLAUDE_PLUGIN_ROOT/mon.js" (the plugin var); for a clone,
# substitute the real path so the skill works without the plugin runtime.
sed "s|\$CLAUDE_PLUGIN_ROOT|$CLONE_DIR|g" "$CLONE_DIR/skills/monday-tasks/SKILL.md" > "$DEST/SKILL.md"

echo "Installed skill -> $DEST"
echo "CLI            -> $CLONE_DIR/mon.js"
echo
echo "Next, in a terminal (asks for your monday token, hidden, then which boards to track,"
echo "and turns on session links):"
echo "  node \"$CLONE_DIR/mon.js\" setup"
