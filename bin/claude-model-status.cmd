@echo off
setlocal
REM claude-model-status — Show current profile + proxy status
call "%~dp0claude-model-switcher-runner.cmd" --status
