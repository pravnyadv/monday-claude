# Contributing

Thanks for helping out. This is a small, dependency-free tool, keep it that way.

## Ground rules

- **No runtime dependencies.** `mon.js` uses only the Node standard library (built-in `fetch`, `node:test`). Please don't add npm packages for things the platform already does.
- **Node 20+.** The code uses `--env-file`, top-level `fetch`, and the built-in test runner.
- **Match the style.** 2-space indent, single quotes, semicolons (see `.editorconfig`). Small, readable functions over clever ones.

## Developing

```bash
git clone https://github.com/pravnyadv/monday-claude.git
cd monday-claude
npm test            # unit tests — no network, no token
```

The tests cover the pure logic (config normalization, column detection, person
resolution, the column-value/mention builders, backoff, and the retry client via
an injected `fetch`). If you touch any of that, add or update a test. Network code
is kept behind `createClient({ fetch })` so it can be tested without hitting monday.

## Pull requests

- One focused change per PR, with a clear description of the behavior change.
- `npm test` must pass (CI runs it on Node 20 and 22).
- If you add or change a command, update the header comment in `mon.js`, the
  `README.md` command list, and `skills/monday-tasks/SKILL.md` if the agent-facing
  behavior changes.
- Don't commit `reference.json` or `.env` (both are gitignored, they're account-specific/secret).

## Reporting monday API quirks

A lot of this tool's value is the encoded API gotchas. If you find a new one,
note it in `CLAUDE.md` under "API gotchas" with what you actually observed.
