# codex-mcp

Stdio MCP server that wraps the local Codex CLI (`/opt/homebrew/bin/codex` by default). Exposes simple tools for running prompts and basic filesystem access inside a configurable workspace.

## Requirements
- Node.js
- Codex CLI installed and accessible at `/opt/homebrew/bin/codex` or set `CODEX_PATH`

## Install / Run
```bash
cd codex-mcp
npm install  # no deps, keeps package-lock empty
node index.js --workdir /path/to/workdir   # default: ~/codex-work
```
Use `./index.js` directly if executable bits are set.

## Tools
- `codex_run` — run a prompt with optional `model` and `timeout` seconds.
- `codex_resume` — continue the last session with a follow-up `prompt`.
- `fs_read` / `fs_write` / `fs_list` — operate within the configured workdir only.

Outputs include trimmed stdout/stderr; processes are auto-killed after the provided timeout (default 300s).

## Notes
- Uses `--full-auto` and `--skip-git-repo-check` for headless operation.
- Paths are sandboxed to the chosen workdir; traversal outside is rejected.
- Configure `CODEX_PATH` if the CLI lives elsewhere.
