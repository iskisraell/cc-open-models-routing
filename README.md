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
│  { "model": "glm-5.1", ... }      │
│            ↓ model.startsWith("MiniMax")?
│       ┌────┴────┐                   │
│       no       yes                  │
│       ▼         ▼                   │
│   Z.AI     MiniMax                  │
│  api.z.ai  api.minimax.io          │
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

### 3. One-Time Profile Setup

Choose the profile you want. For mixed routing (recommended):

```bash
# Apply efficiency mode — does NOT start Claude, just configures settings
bun run switcher:efficiency
```

Or use a single provider:

```bash
bun run switcher:glm      # All tasks → Z.AI
bun run switcher:minimax  # All tasks → MiniMax
```

### 4. Add to PATH (optional)

Add the repo's `bin/` directory to your PATH so `cc` and shortcut commands are available globally:

```powershell
# Add to your PowerShell profile or run manually:
$env:PATH += ";C:\path\to\cc-open-models-routing\bin"
```

Or create shortcuts in `C:\Users\<you>\bin\` that point to this repo's scripts.

## Usage

### Quick Start (recommended)

```bash
# First time: apply efficiency profile (one-time)
bun run switcher:efficiency

# Every session: use the cc launcher
cc                    # ensures proxy + starts Claude with bypass permissions
cc --model sonnet    # pass custom claude flags
```

### Available Commands

```bash
# Apply profiles
bun run switcher:efficiency   # GLM main + MiniMax subagents (recommended)
bun run switcher:glm           # Direct Z.AI routing
bun run switcher:minimax       # Direct MiniMax routing
bun run switcher:status        # Show current profile + proxy status
bun run switcher               # Interactive TUI menu

# Direct proxy control
bun run proxy:start           # Manually start proxy
bun run proxy:stop            # Manually stop proxy
bun run switcher --ensure-proxy  # Ensure proxy running, exit (used by cc launcher)
```

### Launcher Shortcuts

If you added the `bin/` directory to PATH:

```bash
cc                        # Efficiency mode: proxy + bypass permissions
cc-use-efficiency          # Apply efficiency + launch Claude in one step
claude-model-switcher      # Open TUI menu
claude-model-status        # Show status
claude-use-glm             # Switch to GLM direct
claude-use-minimax         # Switch to MiniMax direct
```

## Resilience

| Scenario | Behavior |
|---|---|
| Apply efficiency, restart terminal | Proxy survives (OS process). Claude reconnects fine. |
| Apply efficiency, restart computer | Proxy dies. Next switcher command (`cc`, `bun run switcher:*`, etc.) auto-restarts it. |
| Claude crashes | Proxy keeps running. Claude reconnects. |
| Port 3472 occupied | Switcher kills stale process, rebinds. |
| Switch away from efficiency | Proxy stopped, port freed. |

## Project Structure

```
cc-open-models-routing/
├── bin/                           # Windows .cmd shortcuts
│   ├── cc.cmd                     # Efficiency launcher: proxy + bypass-perms + claude
│   ├── cc-use-efficiency.cmd      # Apply efficiency + launch Claude
│   ├── claude-model-switcher.cmd  # Open TUI menu
│   ├── claude-model-status.cmd    # Show status
│   ├── claude-use-glm.cmd        # Switch to GLM direct
│   ├── claude-use-minimax.cmd     # Switch to MiniMax direct
│   └── claude-model-switcher-runner.cmd  # Generic script runner
├── src/
│   ├── claude-proxy.ts           # HTTP routing proxy (Bun-native, streaming)
│   └── claude-model-switcher.ts   # CLI for profile switching + proxy lifecycle
├── package.json
├── CLAUDE.md                       # Agent instructions
└── README.md
```

## Port

Uses `3472` — unlikely to conflict with common services. Verify with:
```powershell
netstat -ano | findstr 3472
```
