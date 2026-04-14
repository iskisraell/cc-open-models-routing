@echo off
setlocal
REM cc-use-efficiency — Apply efficiency profile and start Claude.
REM Usage: cc-use-efficiency [optional claude args]
REM
REM This is a convenience shortcut that:
REM   1. Applies the efficiency profile (starts proxy if not running)
REM   2. Launches Claude with bypass permissions + any passed args

call "%~dp0claude-model-switcher-runner.cmd" --apply efficiency

echo.
echo Starting Claude Code with Efficiency mode...
echo.

claude --dangerously-skip-permissions %*
