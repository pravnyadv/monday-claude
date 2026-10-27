# Security

## Your monday API token

`mon.js` reads your token from the `monday_api_key` environment variable, else from the file `setup`/`login` saves (`monday-token` next to `reference.json`, `chmod 600`). Treat it like a password:

- It acts **as the user it belongs to**. Anyone with the token can read and write everything that user can in monday.
- `setup` and `login` ask for it with hidden input. Don't paste it into a chat or pass it as a command argument.
- Never commit it. `.env` and `monday-token` are gitignored; keep it that way.
- Prefer a scoped token where monday allows it, and rotate it if it leaks.

## Where data goes

- The token is sent only to monday: `https://api.monday.com/v2`, and `https://mcp.monday.com/mcp` for the commands that use monday's hosted MCP server (`insights`, `automations`, `meetings`, `mcp`).
- `reference.json` is not secret (board and column ids, status labels, a name to id people map), but it describes your workspace, so it is gitignored.
- Session links (`links.db`, next to `reference.json`) stay on your machine. The hook stores session ids, monday item ids, repo and branch names and MR URLs, never prompt text. To learn an MR's branch and the task its description links, it runs your own `glab` or `gh`, with their logins; nothing is sent anywhere else.
- `setup` edits `~/.claude/settings.json` only after asking (or with `--yes`), and only to add the hook. It merges into the file and keeps the previous version as `settings.json.bak`.

## Reporting a vulnerability

If you find a security issue in this tool (for example, the token being logged,
written anywhere but its own file, or sent anywhere other than monday), please
report it privately via a GitHub security advisory on this repository rather than
opening a public issue. We'll respond as soon as we can.

This project has no runtime dependencies, which keeps its supply-chain surface
small; please keep it that way when contributing.
