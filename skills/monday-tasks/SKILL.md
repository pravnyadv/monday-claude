---
name: monday-tasks
description: "Read and write monday.com tasks from the terminal via the mon.js CLI (posts as the API token owner). Use for reading an item or its updates, my open items and unanswered mentions, setting status, assignees or any column, posting updates, threaded replies or descriptions, handing a task over, and monday meetings, insights or automations."
allowed-tools: Bash
---

## monday.com via mon.js

The `mon.js` CLI wraps the monday.com GraphQL API and hides the fiddly bits (status-label exactness, assignee JSON shape, @mentions, item descriptions). Use it for any monday read/write.

**Running it.** When installed as a plugin, the CLI is at `$CLAUDE_PLUGIN_ROOT/mon.js`:

```bash
node "$CLAUDE_PLUGIN_ROOT/mon.js" <command> [args]
```

(If you installed via `git clone` + `install.sh`, that path was replaced with your clone path at install time.) The CLI needs a monday API token (from `mon.js login`, the `monday_api_key` env var, or a `.env`). It acts **as the user it belongs to**, so every status change, assignee, update, comment, and description is that user speaking.

**Setting up, or "No monday token found":** ask the user to run `node "$CLAUDE_PLUGIN_ROOT/mon.js" setup` themselves in a terminal (print the command with the real path filled in). It asks for the token with hidden input, then the boards to track, and turns on session links. Never ask them to paste the token into the chat, and never pass it as an argument: that puts the secret in the transcript and shell history. If they'd rather pick boards here, once the token is saved run `mon.js init` to list boards, ask which, and run `mon.js setup --boards <id,id> --yes`.

**Adding a board later:** `mon.js init <boardId>` (auto-detects the status and people columns, and warns if a board has several so you can pick), or re-run `setup`.

**Commands** (`node mon.js help` prints them all; add `--json` for structured output and parse that when you need data):

- Reading: `get <itemId> --full` is the one call for picking up a task (columns with ids, description, last 5 updates with replies), instead of `get` + `desc-get` + `update-get`. `updates <itemId> [--limit N] [--images dir]` reads the whole conversation, `update-get <updateId>` one post, `activity <itemId>` who changed what, `mine` my open items by status (parked ones like Backlog/Pause are only counted, `--all` lists them) and the mentions I haven't answered in 14 days (`--days N`).
- Lookups: `people <name>` for an id, `labels [boardId]` for the valid statuses. Use these rather than reading `reference.json` by hand.
- Writing: `status`, `assign`, `set <itemId> "<column>" <value>` (any common column; `""` clears it), `estimate <itemId> <hours>`, `update`, `reply`, `update-edit`, `update-delete`, `attach <updateId> <file...>` (files on an update or reply), `like`/`unlike <updateId>`, `desc-set`, `handoff`. Never hand-roll GraphQL for these.
- Hosted monday MCP (same token): `insights <boardId> [--by col]`, `automations <boardId>`, `meetings ["query"]` / `meetings --id <id>`, `mcp tools`, `mcp <tool> '<json>' [--write]` (write tools are refused without `--write`). Use these instead of registering monday's MCP server separately; the CLI keeps one way in and enforces the posting rules.

**Finding an item id:** the user usually gives a monday URL (the number after `/pulses/` is the item id). If you only have a title, use `search <boardId> "<text>"` (or `list <boardId>`) to find the id first.

**Posting** (`update`/`reply`/`update-edit`/`handoff`): write the HTML with `@First` or `@{Full Name}` where a mention goes, and pass other people as `--cc A,B` (it adds the last "CC:" line). Greet the primary person inline in the first line; everyone else goes in `--cc` (the CLI refuses a cc'd person who is already in the body). The CLI turns names into real mention anchors, removes line breaks between tags (monday shows each as a blank line), and refuses text with em/en dashes, arrow glyphs, bullet dots or curly quotes (`--allow-style` is for quoting someone else's text). Don't hand-build anchors, minify yourself (a naive `>\s+<` strip also deletes the space between two CC anchors) or grep for dashes. Never use `mentions_list` or the MCP `create_update` `mentionsList`: both append a duplicate footer of names. For long bodies write the HTML pretty in a file and pass `@file.html`, or pipe with `-`.

**Confirm with a dry run.** Every write takes `--dry-run`, which prints exactly what would be sent (final HTML, resolved mentions, validated label, people ids) and changes nothing. Show that to the user as the draft, and run the same command without `--dry-run` only after they say yes. A go-ahead for one post does not cover a follow-up, and the same goes for `status`, `assign`, `set`, `estimate` and `handoff`.

**Several separate actions:** post the update, then `status` (validated against the board), then `assign`, then any time entry. Read the item back with `get` at the end.

**Handing a task over** (e.g. to QA): one command does the update, status, estimate and assignee, then reads the item back:

```bash
node mon.js handoff <itemId> --to <Name> --mr <url> [--mr <url>] --body @handoff.html --cc A,B [--estimate 6] [--status "<label>"] --dry-run
```

It greets `--to` in the first line if the body doesn't, links each MR, defaults the status to the board's "Ready For QA"-like label, and replaces the assignees with `--to` (`--keep-assignees` adds instead). Everything is validated before the first write.

**Editing:** `update-edit` fixes a posted body in place but can't add mentions (monday doesn't ping on edit); to mention someone new, `update-delete` and post again. To edit or answer a **reply** (not a top-level update), pass the post URL the user gave (`.../pulses/<item>/posts/<id>`) or add `--item <itemId>`: monday can't look a reply up by id alone. Replying to a reply goes under its update.

**Which Claude sessions and MRs belong to a task:** `mon.js links <itemId|mrUrl>` (or `--session <id>`, `--branch <b> --repo <r>`) lists the task's monday items, MRs and Claude sessions, best match first, each with the `cd <dir> && claude --resume <id>` that reopens it. Use it to pick up earlier context on a task, or to answer "which session did X". A hook fills it as you work; `links add <itemId> --mr <url>` links by hand. To reopen a task's session, give the user `mon.js resume <itemId> --print` (the exact `cd ... && claude --resume ...`, or a new session named `monday_<id>`); the hook also names an untitled task session `monday_<id>` when it is resumed, so `/rename` isn't needed.

### Keeping reference.json current

`reference.json` is a snapshot, it does not update itself. When monday changes, re-sync:

- **`assign` fails with "Unknown person"** (a new teammate joined): run `mon.js refresh`, then retry the assign.
- **`status` rejects a label** (labels changed on a board): run `mon.js refresh`, then retry.
- **An item is on a board that "isn't configured"**: run `mon.js init <boardId>` for that board, then retry.

The CLI's error messages say which of these to run. Do the re-sync and retry rather than reporting the failure to the user.

### Things worth knowing

- **An update/post is NOT the item description.** A URL like `.../pulses/<itemId>/posts/<updateId>` is one update; read it (text + images) with `update-get <updateId>` and `update-images <updateId> [outDir]`. `desc-get` reads the item's description, a separate document. To reply UNDER an existing update as a threaded comment, use `reply <updateId> "<html>|@file.html"` (not `update`/`comment`, which post a new top-level update).
- **`desc-set` REPLACES the whole description**; there is no append. Subitems cannot be reordered through the API.
- **Mentions:** a plain `@Name` typed as text in monday does not ping anyone; the CLI's `@First` / `@{Full Name}` expansion is what makes it a real mention. `comment` is an alias of `update`.
- **Time tracking** can be read (`get --full` shows the total) but not written through the API.
- **Do not use the claude.ai monday.com integration** (`mcp__*_monday_com__*`) for writes if you rely on posting as a specific user, it authenticates as a different account. The `mon.js` token is the single source of who posts.
- **Write in the first person, as the token owner.** Every post is that person speaking, so use "I"/"me"/"my" (e.g. "I checked prod", "assigned to me"), never refer to the token owner in the third person.
- **Keep updates short.** Lead with the outcome or decision, a few bullets at most, plain English. Give the answer, not the diagnosis: the reader needs the conclusion and current state, not the mechanism. If it runs past ~10 lines, trim it or move the detail elsewhere and link it.
