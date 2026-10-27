# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [Unreleased]

### Added
- `attach <updateId> <file> [more...]`: attach local files to an update or reply (images show inline),
  through monday's multipart `/file` endpoint. Only a 429 is retried, since an upload may have landed.
- `like <updateId>` / `unlike <updateId>`: like or unlike an update or reply.

## [1.3.0] - 2026-10-17

### Added
- `mine --by board`: assigned tasks grouped under their board's name, each with its status and how many
  Claude sessions the session links tie to it. A subitem shows as `Parent task > subitem`.
- `mine --status "A,B"`: only tasks with those labels (case-insensitive), e.g. the ones to pick up next.
- `mine --tasks`: skip the unanswered-mentions part.

### Changed
- `mine --json` returns the tasks it shows (`open`) and a count of parked ones, not every open task.

## [1.2.2] - 2026-10-16

### Fixed
- `update-get`, `update-images`, `update-edit`, `update-delete` and `reply` work on replies. monday's
  `updates(ids:)` returns top-level updates only, so a reply is found through its item: pass
  `--item <itemId>` or the post URL (`.../pulses/<itemId>/posts/<id>`). Replying to a reply threads
  under its update, since monday doesn't nest replies. Found by a live write test.

## [1.2.1] - 2026-10-16

### Fixed
- An MR whose description has no task link is no longer tied to whatever task its session named
  last; the session's task is only a stand-in when glab/gh can't be asked.
- An MR's repo comes from its URL, not from the directory the create command started in.
- `setup` prints the mr-rebase-bot `sessionIndex` with `--no-names`, as `npm run init` writes it.

## [1.2.0] - 2026-10-16

### Added
- Session links: a Claude Code hook (`hooks/links-hook.js`, registered by the plugin) records which
  sessions, monday items and MRs belong together in `links.db`. `mon.js links <item|mr>` (and
  `--session`, `--branch`) answers from any side, best match first with a resume command and a
  `--json` shape for tools; `links add` links by hand; `links import` backfills from transcripts.
- An MR's task comes from the task link in its description and its branch from the host
  (glab/gh) when available; the earliest creation wins over later guesses.
- `handoff --mr` records its MRs in the links store directly.
- Sessions name themselves: on SessionStart (startup, resume, fork) the hook names an untitled
  session that belongs to exactly one monday item `monday_<id>` (never one you named;
  `MONDAY_LINKS_AUTONAME=0` turns it off). `mon.js resume <itemId>` reopens the task's best session,
  or starts one named `monday_<id>`.
- `mon.js setup`: one re-runnable first-run command. It asks for the token (hidden) and the boards
  to track, registers the session-links hook (clone installs; plugin installs get it from
  `hooks/hooks.json`), and backfills links. `--boards --yes`
  runs it without questions.

### Security
- Tests and docs use fictional people, ids and hosts only.

### Changed
- Config paths live in `lib/paths.js`, shared by the CLI and the hook.

## [1.1.0] - 2026-10-16

### Added
- Posting pipeline for `update`, `reply`, `update-edit` and `handoff`: `@First` / `@{Full Name}`
  become mention anchors, `--cc` adds the CC line, line breaks between tags are removed, and posts
  with em/en dashes, arrows, bullet dots or curly quotes are refused (`--allow-style` overrides).
- `--dry-run` on every write, printing exactly what would be sent.
- `get --full` / `--updates N`, `updates <itemId>`, replies in `update-get`, `people`, `activity`, `mine`.
- `set <itemId> <column> <value>` for any common column type, and `estimate`.
- `update-edit` (refuses to add mentions, which monday doesn't ping on edit) and `update-delete`.
- `handoff`: update, status, estimate, assignee and an optional hook in one validated command.
- Hosted monday MCP client (same token): `insights`, `automations`, `meetings`, and an `mcp` passthrough
  that needs `--write` for write tools.
- Board `aliases` (legacy role names become aliases, including `estimate`), `handoffStatus`, `hooks`
  and `doneStatuses` in `reference.json`, all kept by `refresh`.

### Changed
- `comment` no longer sends `mentions_list` (monday appended a duplicate footer of names); it is an
  alias of `update`, and extra `@Name` arguments are refused with a hint.
- Unknown `--flags` are an error instead of being read as positional arguments.

### Fixed
- Minifying no longer removes the space between two adjacent mention anchors (a CC line used to read
  "@A@B").

## [1.0.0] - 2026-09-10

Initial public release.

### Added
- Account-agnostic `mon.js` CLI wrapping the monday.com GraphQL API.
- `init` auto-discovers boards and detects the status/people columns by type,
  warning when a board has several candidates so you can override.
- `refresh` re-syncs people and status labels for configured boards and never
  re-guesses a hand-picked column.
- `list <boardId>` and `search <boardId> "<text>"` with cursor pagination.
- `--json` output on every command; `help` command.
- Retryable API client (429, 5xx, network errors, and monday complexity/rate
  limits) with exponential backoff that honors `Retry-After`.
- monday-tasks Claude Code skill, installable as a plugin (bundled marketplace)
  or by clone + `install.sh`.
- Unit tests via the built-in Node test runner; CI on Node 20 and 22.

### Notes
- `reference.json` is stored next to the script if one already exists there,
  otherwise under `$XDG_CONFIG_HOME/monday-claude/` (default `~/.config/...`) so a
  plugin update can't wipe it. Override with `MONDAY_CLAUDE_CONFIG`.
- A legacy role-keyed `reference.json` is read transparently, so existing setups
  keep working without migration.
