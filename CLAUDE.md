# Agent Instructions

## Project Overview

This is the `cc-open-models-routing` project — a local HTTP proxy and CLI tool for routing Claude Code requests between Z.AI (GLM models) and MiniMax based on model tier, enabling an "efficiency mode" where the main orchestrator uses GLM-5.1 and subagents use MiniMax-M2.7.

## Architecture

- **`src/claude-proxy.ts`** — Bun HTTP proxy server. Listens on port 3472. Routes:
  - `MiniMax-*` (case-insensitive) model → `https://api.minimax.io/anthropic`
  - All other models → `https://api.z.ai/api/anthropic`
  - Streaming-compatible (SSE).

- **`src/claude-model-switcher.ts`** — CLI tool to switch Claude Code profiles:
  - `glm-5.1` — direct Z.AI routing
  - `minimax-m2.7` — direct MiniMax routing
  - `efficiency` — routes through local proxy (port 3472)

## Token Setup

Tokens are stored as Windows User environment variables (never hardcoded):
- `CLAUDE_PROFILE_ZAI_TOKEN` — Z.AI API token
- `CLAUDE_PROFILE_MINIMAX_TOKEN` — MiniMax API token

Set them via PowerShell:
```powershell
[System.Environment]::SetEnvironmentVariable('CLAUDE_PROFILE_ZAI_TOKEN', 'your-zai-token', 'User')
[System.Environment]::SetEnvironmentVariable('CLAUDE_PROFILE_MINIMAX_TOKEN', 'your-minimax-token', 'User')
```

## Profile Lifecycle

- **Apply `efficiency`**: Proxy is spawned as detached background process. PID stored in `~/.claude/model-switcher-state.json`.
- **Switch away**: Proxy is killed and port freed.
- **Idle recovery**: Any switcher invocation (`cc`, `bun run switcher:*`, etc.) checks if efficiency proxy is dead and restarts it.
- **Computer restart**: Proxy dies. On next switcher command, idle recovery restarts it.

## The `cc` Launcher

`bin/cc.cmd` is the recommended way to start Claude in efficiency mode:
1. Calls switcher with `--ensure-proxy` (idle recovery)
2. Launches `claude --dangerously-bypass-permissions`

`bin/cc-use-efficiency.cmd` does both in one step: applies efficiency profile + starts Claude.

## Port

`3472` — chosen to minimize conflict risk. Verify it's free before use.

## Testing

```bash
bun run src/claude-proxy.ts        # Start proxy (foreground)
curl http://localhost:3472/health  # Should return {"status":"ok"}

bun run switcher --ensure-proxy    # Ensure proxy running, exit
bun run switcher --status         # Show current profile + proxy status
bun run switcher --apply efficiency --smoke-test
```

## Security Notes

- API tokens are read from Windows User environment variables at runtime.
- Proxy runs on localhost only — not exposed externally.
- No tokens are ever written to disk or source files.
