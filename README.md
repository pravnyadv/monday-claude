# monday-claude

A small CLI (`mon.js`) and a Claude Code skill for working with monday.com from your terminal or from Claude. It reads and updates tasks, posts updates that follow your team's conventions, and remembers which Claude session worked on which task and merge request.

No dependencies. Node 20+ (Node 22.13+ for session links).

## Why not just use monday's MCP server?

monday's hosted MCP server is good for quick, ad-hoc reads. This CLI uses it too, for meetings, board insights and automations. For day-to-day work the CLI adds what the MCP leaves out:

| | monday MCP directly | mon.js |
|---|---|---|
| Who it posts as | The account that connected it (OAuth), which may not be you | Always the owner of your token |
| @mentions | `mentionsList`, which adds a duplicate list of names under the post | Real inline mentions from `@Name` |
| Formatting | Line breaks become blank gaps in the post | Compacted before sending |
| Writing rules | None | Refuses em/en dashes, arrows and curly quotes |
| Preview before writing | No | `--dry-run` on every write |
| Stability | Tools get renamed, no version to pin | Versioned GraphQL API |
| Shortcuts | Raw building blocks | `handoff`, `mine`, `set`, `estimate`, ... |
| Claude sessions | Knows nothing about them | Links sessions, tasks and MRs; `resume` reopens a task's session |
| Use from scripts | Needs an MCP client | Plain commands with `--json` |
| Context cost | About 100 tool definitions | One skill |

## Install

In Claude Code:

```
/plugin marketplace add pravnyadv/claude-plugins
/plugin install monday-tasks@pravnyadv
```

Then tell Claude **"set up monday-tasks"**. It gives you one command to run in a terminal, `mon.js setup`, which asks for your monday token (hidden input; get one from your avatar, Developers, My access tokens), asks which boards to track, and turns on session links.

Without the plugin:

```bash
git clone https://github.com/pravnyadv/monday-claude.git && cd monday-claude
./install.sh
node ./mon.js setup
```

## Everyday use

```
mon.js mine                         my open tasks and the mentions I haven't answered
mon.js mine --by board --status "Ready To Start"    what I can pick up next
mon.js get <id> --full              a task: columns, description, recent updates
mon.js update <id> "<p>Hi @Alex, done.</p>" --cc Sam,Kim --dry-run
mon.js status <id> "Ready For QA"
mon.js set <id> "Due date" 2026-11-06
mon.js handoff <id> --to Alex --mr <url> --body @note.html     update + status + assignee in one step
mon.js links <id or MR url>         the task's MRs and Claude sessions
mon.js resume <id>                  reopen the task's Claude session, or start one named monday_<id>
mon.js resume <id> --new --url <u>  new session with "monday task <u> " typed in, unsent
```

`mon.js help` lists every command. Add `--json` to any command for machine-readable output, and `--dry-run` to any write to see exactly what would be sent.

## Session links

A hook records, as you work, which Claude sessions, monday tasks, merge requests and branches belong together. It learns this from task links in your prompts, session names, the branches you edit, and MRs you create (an MR's task comes from the first task link in its description). It keeps ids and URLs only, never prompt text, and stores them in `links.db` on your machine.

When you resume an unnamed session that belongs to one task, the hook names it `monday_<id>`. Claude Code deletes transcripts after 30 days by default; raise `cleanupPeriodDays` in `~/.claude/settings.json` if you want to resume older sessions.

## Notes

- Your token acts as you: everything the CLI writes is you speaking. `setup` saves it in a file only you can read. See [SECURITY.md](SECURITY.md) for what is stored and where data goes.
- Board and people ids live in `reference.json` (gitignored). Run `mon.js refresh` when a teammate joins or labels change.
- Maintainer notes and monday API gotchas: [CLAUDE.md](CLAUDE.md). Tests: `npm test`.

## License

MIT
