@echo off
setlocal
REM Generic runner for claude-model-switcher.ts — passes all arguments through.
REM Usage: claude-model-switcher-runner.cmd [switcher args]
REM
REM The runner lives in <repo>/bin/ and runs the switcher from the repo root.

set "REPO_DIR=%~dp0.."
"%USERPROFILE%\.bun\bin\bun.exe" run --cwd "%REPO_DIR%" claude:model-switcher -- %*
