# cc-open-models-routing

Local HTTP proxy + CLI tool for routing Claude Code between **Z.AI (GLM-5.1)** and **MiniMax (M2.7)** based on model tier — giving you GLM quality for orchestration and MiniMax speed/cost for subagents.

## Profiles

| Profile | Provider | Main Model | Notes |
|---|---|---|---|
| `glm-5.1` | Z.AI (direct) | GLM-5.1 | All tasks → Z.AI |
| `minimax-m2.7` | MiniMax (direct) | MiniMax-M2.7 | All tasks → MiniMax |
| `efficiency` | Local proxy | GLM-5.1 | Opus tier → Z.AI · Sonnet/Haiku tier → MiniMax |

## How Efficiency Mode Works

```
Claude Code
    │
    ▼ (ANTHROPIC_BASE_URL = http://localhost:3472)
┌─────────────────────────────────────┐
│         claude-proxy (port 3472)     │
│                                      │
│  POST /v1/messages                  │
│  { "model": "glm-5.1", ... }        │
│            ↓ model.startsWith("minimax")?
│       ┌────┴────┐                   │
│       no       yes                  │
│       ▼         ▼                   │
│   Z.AI     MiniMax                  │
│  api.z.ai  api.minimax.io           │
└─────────────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) runtime
- Windows (PowerShell-based env var management)
- Z.AI token plan subscription
- MiniMax token plan subscription

## Setup

### 1. Set API Tokens

```powershell
# Z.AI token (from z.ai dashboard)
[System.Environment]::SetEnvironmentVariable('CLAUDE_PROFILE_ZAI_TOKEN', 'your-zai-token', 'User')

# MiniMax token (from platform.minimax.io)
[System.Environment]::SetEnvironmentVariable('CLAUDE_PROFILE_MINIMAX_TOKEN', 'your-minimax-token', 'User')
```

Restart your terminal after setting.

### 2. Install

```bash
# Clone the repo
git clone https://github.com/iskisraell/cc-open-models-routing.git
cd cc-open-models-routing

# Install dependencies
bun install
```

### 3. Apply a Profile

```bash
# Use efficiency mode (recommended)
bun run switcher:efficiency

# Or use a single provider
bun run switcher:glm
bun run switcher:minimax
```

### 4. Start Claude Code

```bash
# Open a new terminal, then:
claude
```

## Commands

```bash
bun run switcher:efficiency   # Apply efficiency mode + start proxy
bun run switcher:glm           # Direct Z.AI routing
bun run switcher:minimax       # Direct MiniMax routing
bun run switcher:status        # Show current profile + proxy status
bun run switcher               # Interactive TUI menu

# Direct proxy control
bun run proxy:start            # Manually start proxy
bun run proxy:stop             # Manually stop proxy
```

## Resilience

| Scenario | Behavior |
|---|---|
| Apply efficiency, restart terminal | Proxy survives (OS process). Claude reconnects fine. |
| Apply efficiency, restart computer | Proxy dies. Next switcher command auto-restarts it. |
| Claude crashes | Proxy keeps running. Claude reconnects. |
| Port 3472 occupied | Switcher kills stale process, rebinds. |
| Switch away from efficiency | Proxy stopped, port freed. |

## Project Structure

```
cc-open-models-routing/
├── src/
│   ├── claude-proxy.ts        # HTTP routing proxy (Bun-native, streaming)
│   └── claude-model-switcher.ts # CLI for profile switching + proxy lifecycle
├── package.json
├── CLAUDE.md                   # Agent instructions
└── README.md
```

## Port

Uses `3472` — unlikely to conflict with common services. Verify with:
```powershell
netstat -ano | findstr 3472
```
