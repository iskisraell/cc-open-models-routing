@echo off
setlocal
REM cc — Claude Code with efficiency mode: ensures proxy is running, then launches Claude.
REM
REM Usage: cc [optional claude args]
REM   cc                     — starts Claude with efficiency proxy
REM   cc --model sonnet     — Claude with custom args
REM
REM Prerequisites:
REM   1. Run: bun run claude:use:efficiency  (one-time profile setup)
REM   2. Add the bin dir to PATH: setx PATH "%PATH%;C:\path\to\cc-open-models-routing\bin"
REM
REM For status checks:
REM   bun run claude:model-status

REM Ensure proxy is running (idle recovery for efficiency mode)
call "%~dp0claude-model-switcher-runner.cmd" --ensure-proxy

REM Launch Claude Code with bypass permissions + any passed arguments
claude --dangerously-skip-permissions %*
