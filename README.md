# codex-cli-mcp

An MCP server that lets Claude (or other MCP clients) run tasks through your local [Codex CLI](https://github.com/openai/codex) using multiple model profiles. Optionally syncs available models from an OpenWebUI database.

## What This Does

- Exposes Codex CLI as MCP tools (`codex_run`, `codex_resume`, etc.)
- Pulls model profiles from OpenWebUI's SQLite DB (falls back to hardcoded list)
- Provides sandboxed filesystem operations within a working directory
- Includes an isolated "security" profile with stricter permissions

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js | Any recent version |
| Codex CLI | Default path: `/opt/homebrew/bin/codex`. Override with `CODEX_PATH` env var |
| sqlite3 | Used to read OpenWebUI DB. Skip if using fallback profiles only |

---

## Setup

```bash
git clone https://github.com/PushPullCommitPush/codex-cli-mcp.git
cd codex-cli-mcp
npm install
```

### Authenticate Codex

You need to log in once per `CODEX_HOME` directory:

```bash
# Main profile
CODEX_HOME=$(pwd) codex login

# Security profile (uses isolated home)
CODEX_HOME=$(pwd)/profiles/security codex login
```

### Run the Server

```bash
node index.js --workdir ~/codex-work
```

Default workdir is `~/codex-work`. All filesystem tools are sandboxed to this directory.

---

## MCP Tools

### `codex_run`
Execute a prompt through Codex.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | yes | The task to run |
| `profile` | no | Profile name (see below) |
| `model` | no | Override the profile's default model |
| `timeout` | no | Seconds before kill (default: 300) |

### `codex_resume`
Continue the last Codex session with a follow-up message.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `message` | yes | Follow-up prompt |
| `profile` | no | Must match the original session's profile |

### `codex_profiles`
List available profiles and their source (OpenWebUI DB or fallback).

### `fs_read` / `fs_write` / `fs_list`
Read, write, or list files. Paths are restricted to `workdir`—attempts to escape are rejected.

---

## Profiles

Profiles map to model configurations. They're auto-synced from OpenWebUI if available:

```
openwebui-data/webui.db → SELECT id, name, base_model_id FROM model
```

**Legacy aliases** (for convenience):
- `fast` → oss20b
- `heavy` → oss120b
- `reasoning` → deepseek
- `coder` → qwen-coder
- `security` → isolated security profile

### Security Profile

The `security` profile runs in an isolated environment:
- Separate `CODEX_HOME` at `profiles/security/`
- `approval_policy=untrusted`
- `sandbox=workspace-write`

All other profiles run with `--dangerously-bypass-approvals-and-sandbox` (required to avoid macOS sandbox issues with MCP stdio).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_PATH` | `/opt/homebrew/bin/codex` | Path to Codex binary |
| `OPENWEBUI_DB` | `openwebui-data/webui.db` | Path to OpenWebUI database |

---

## Notes

- Config files (`config.toml`, `profiles/security/config.toml`) are regenerated on each run. Don't edit them manually.
- Timeout kills the Codex process; stderr/stdout are captured and returned.
