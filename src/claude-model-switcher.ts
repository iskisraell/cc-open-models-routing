import {
  createCliRenderer,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeProfile {
  id: "glm-5.1" | "minimax-m2.7" | "efficiency";
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** Primary token env var name */
  tokenEnvVar: string;
  /** Extra token env var (efficiency mode needs both z.ai + minimax) */
  tokenEnvVar2?: string;
  disableNonessentialTraffic: boolean;
  note: string;
}

interface ClaudeSettings {
  env?: Record<string, string>;
  skipDangerousModePermissionPrompt?: boolean;
  [key: string]: unknown;
}

interface SwitcherState {
  activeProfile?: string;
  proxyPid?: number;
  proxyPort?: number;
  lastSwitchedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROXY_PORT = 3472;

const claudeDir = join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const statePath = join(claudeDir, "model-switcher-state.json");
const snapshotPathByProfile: Record<ClaudeProfile["id"], string> = {
  "glm-5.1": join(claudeDir, "settings-zai.json"),
  "minimax-m2.7": join(claudeDir, "settings-minimax.json"),
  "efficiency": join(claudeDir, "settings-efficiency.json"),
};

const managedEnvKeys = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "API_TIMEOUT_MS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_MODEL_PROFILE",
] as const;

const profiles: ClaudeProfile[] = [
  {
    id: "glm-5.1",
    name: "GLM 5.1",
    provider: "Z.AI",
    model: "glm-5.1",
    baseUrl: "https://api.z.ai/api/anthropic",
    tokenEnvVar: "CLAUDE_PROFILE_ZAI_TOKEN",
    disableNonessentialTraffic: false,
    note: "Direct Z.AI routing — GLM 5.1 for all tasks",
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    provider: "MiniMax",
    model: "MiniMax-M2.7",
    baseUrl: "https://api.minimax.io/anthropic",
    tokenEnvVar: "CLAUDE_PROFILE_MINIMAX_TOKEN",
    disableNonessentialTraffic: true,
    note: "Direct MiniMax routing — MiniMax M2.7 for all tasks",
  },
  {
    id: "efficiency",
    name: "Efficiency",
    provider: "Local Proxy",
    model: "glm-5.1",
    baseUrl: `http://localhost:${PROXY_PORT}`,
    tokenEnvVar: "CLAUDE_PROFILE_ZAI_TOKEN",
    tokenEnvVar2: "CLAUDE_PROFILE_MINIMAX_TOKEN",
    disableNonessentialTraffic: true,
    note: "Opus tier → GLM 5.1 (z.ai) | Sonnet/Haiku tier → MiniMax M2.7 (MiniMax)",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const parseArgValue = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const hasFlag = (name: string) => args.includes(name);

const readJson = async <T>(path: string, fallback: T) => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const escapePowerShell = (value: string) => value.replace(/'/g, "''");

const runPowerShell = (command: string) => {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      (result.stderr ?? "").trim() || "PowerShell command failed",
    );
  }

  return (result.stdout ?? "").trim();
};

const getUserEnv = (name: string) =>
  runPowerShell(
    `[System.Environment]::GetEnvironmentVariable('${escapePowerShell(name)}','User')`,
  );

const setUserEnv = (name: string, value?: string) => {
  const encodedValue =
    value === undefined ? "$null" : `'${escapePowerShell(value)}'`;
  runPowerShell(
    `[System.Environment]::SetEnvironmentVariable('${escapePowerShell(name)}', ${encodedValue}, 'User')`,
  );
};

const resolveProfile = (id: string | undefined) => {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) {
    throw new Error(`Unknown profile: ${id ?? "<missing>"}`);
  }
  return profile;
};

const loadSettings = async () => readJson<ClaudeSettings>(settingsPath, {});

const loadState = async (): Promise<SwitcherState> =>
  readJson<SwitcherState>(statePath, {});

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

const getProfileToken = (profile: ClaudeProfile) => {
  const token = getUserEnv(profile.tokenEnvVar);
  if (!token) {
    throw new Error(`Missing user environment variable ${profile.tokenEnvVar}`);
  }
  return token;
};

const getProfileToken2 = (profile: ClaudeProfile) => {
  if (!profile.tokenEnvVar2) return undefined;
  const token = getUserEnv(profile.tokenEnvVar2);
  if (!token) {
    throw new Error(`Missing user environment variable ${profile.tokenEnvVar2}`);
  }
  return token;
};

// ---------------------------------------------------------------------------
// Profile env builder
// ---------------------------------------------------------------------------

const buildManagedEnv = (profile: ClaudeProfile) => {
  const token = getProfileToken(profile);

  return {
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: profile.baseUrl,
    API_TIMEOUT_MS: "3000000",
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_SMALL_FAST_MODEL: profile.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
    CLAUDE_CODE_SUBAGENT_MODEL: profile.model,
    CLAUDE_MODEL_PROFILE: profile.id,
    ...(profile.disableNonessentialTraffic
      ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
      : {}),
  } satisfies Record<string, string>;
};

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

/** Check if the proxy process is running by PID stored in state */
const isProxyRunning = async (): Promise<boolean> => {
  const state = await loadState();
  if (!state.proxyPid) return false;

  try {
    // On Windows, use tasklist to check if process exists
    const result = spawnSync("tasklist", ["/FI", `PID eq ${state.proxyPid}`, "/NH"], {
      encoding: "utf8",
    });
    return result.stdout.includes(String(state.proxyPid));
  } catch {
    return false;
  }
};

/** Check if port 3472 is currently bound */
const isPortBound = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const proc = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `netstat -ano | findstr :${PROXY_PORT} | findstr LISTENING`,
      ],
      { encoding: "utf8" },
    );
    let output = "";
    proc.stdout?.on("data", (d) => { output += d; });
    proc.on("close", () => resolve(output.trim().length > 0));
  });
};

/** Kill a process by PID (Windows tree kill) */
const killPid = (pid: number) => {
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  } catch {
    // Process may have already exited
  }
};

/** Stop any process occupying port 3472 */
const clearPort = async () => {
  const bound = await isPortBound();
  if (!bound) return;

  // Find PID on the port
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `(netstat -ano | findstr :${PROXY_PORT} | findstr LISTENING)[0] -split '\\s+' | Select-Object -Last 1`,
  ], { encoding: "utf8" });

  const pid = parseInt((result.stdout ?? "").trim(), 10);
  if (pid && !isNaN(pid)) {
    killPid(pid);
  }

  // Wait for port to be released
  await new Promise((r) => setTimeout(r, 500));
};

/** Start the proxy as a detached background process */
const startProxy = async () => {
  const state = await loadState();

  // If a proxy is already running for this profile, leave it
  if (state.proxyPid && (await isProxyRunning())) {
    console.log(`Proxy already running (PID ${state.proxyPid}), port ${PROXY_PORT}.`);
    return;
  }

  // Stop any stale proxy
  if (state.proxyPid) {
    killPid(state.proxyPid);
    await clearPort();
  } else {
    await clearPort();
  }

  // Get both tokens for the proxy
  const zaiToken = getUserEnv("CLAUDE_PROFILE_ZAI_TOKEN");
  const minimaxToken = getUserEnv("CLAUDE_PROFILE_MINIMAX_TOKEN");

  if (!zaiToken) throw new Error("Missing CLAUDE_PROFILE_ZAI_TOKEN — required for efficiency mode");
  if (!minimaxToken) throw new Error("Missing CLAUDE_PROFILE_MINIMAX_TOKEN — required for efficiency mode");

  const scriptDir = dirname(process.argv[1] ?? import.meta.filename ?? "");
  const proxyPath = join(scriptDir, "claude-proxy.ts");

  // Spawn detached proxy — inherits env, passes tokens via env
  const child = spawn(
    "bun",
    ["run", proxyPath],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PROXY_PORT: String(PROXY_PORT),
        ZAI_API_TOKEN: zaiToken,
        MINIMAX_API_TOKEN: minimaxToken,
      },
    },
  );

  child.unref();

  // Wait for proxy to bind
  let bound = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isPortBound()) {
      bound = true;
      break;
    }
  }

  if (!bound) {
    throw new Error("Proxy failed to start on port 3472 within 5 seconds.");
  }

  // Update state with new PID
  const newState: SwitcherState = {
    ...state,
    activeProfile: state.activeProfile,
    proxyPid: child.pid,
    proxyPort: PROXY_PORT,
    lastSwitchedAt: new Date().toISOString(),
  };
  await writeJson(statePath, newState);

  console.log(`Proxy started on port ${PROXY_PORT} (PID ${child.pid}).`);
};

/** Stop the running proxy */
const stopProxy = async () => {
  const state = await loadState();
  if (!state.proxyPid) {
    await clearPort();
    return;
  }

  killPid(state.proxyPid);
  await clearPort();

  await writeJson(statePath, { ...state, proxyPid: undefined, proxyPort: undefined });
  console.log(`Proxy stopped (was PID ${state.proxyPid}).`);
};

// ---------------------------------------------------------------------------
// Active profile detection
// ---------------------------------------------------------------------------

const detectActiveProfile = async () => {
  const state = await loadState();
  if (
    state.activeProfile &&
    profiles.some((profile) => profile.id === state.activeProfile)
  ) {
    return state.activeProfile;
  }

  const activeBaseUrl = getUserEnv("ANTHROPIC_BASE_URL");
  const settings = await loadSettings();
  const currentModel =
    settings.env?.ANTHROPIC_MODEL ?? getUserEnv("ANTHROPIC_MODEL");

  return (
    profiles.find(
      (profile) =>
        profile.baseUrl === activeBaseUrl ||
        profile.model.toLowerCase() === (currentModel ?? "").toLowerCase(),
    )?.id ?? null
  );
};

// ---------------------------------------------------------------------------
// Apply profile
// ---------------------------------------------------------------------------

const applyProfile = async (profile: ClaudeProfile) => {
  const settings = await loadSettings();
  const state = await loadState();
  const managedEnv = buildManagedEnv(profile);
  const preservedEnv = Object.fromEntries(
    Object.entries(settings.env ?? {}).filter(
      ([key]) =>
        !managedEnvKeys.includes(key as (typeof managedEnvKeys)[number]),
    ),
  );

  const nextSettings: ClaudeSettings = {
    ...settings,
    env: {
      ...preservedEnv,
      ...managedEnv,
    },
    skipDangerousModePermissionPrompt:
      typeof settings.skipDangerousModePermissionPrompt === "boolean"
        ? settings.skipDangerousModePermissionPrompt
        : true,
  };

  await writeJson(settingsPath, nextSettings);
  await writeJson(snapshotPathByProfile[profile.id], { env: managedEnv });

  // Manage proxy lifecycle based on profile
  if (profile.id === "efficiency") {
    await startProxy();
  } else {
    // Switching away from efficiency — stop the proxy
    if (state.activeProfile === "efficiency") {
      await stopProxy();
    }
  }

  await writeJson(statePath, {
    activeProfile: profile.id,
    proxyPid: profile.id === "efficiency" ? (await loadState()).proxyPid : undefined,
    proxyPort: profile.id === "efficiency" ? PROXY_PORT : undefined,
    lastSwitchedAt: new Date().toISOString(),
  });

  managedEnvKeys.forEach((key) => {
    if (key in managedEnv) {
      setUserEnv(key, managedEnv[key as keyof typeof managedEnv]);
      return;
    }
    setUserEnv(key);
  });

  return managedEnv;
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const printStatus = async () => {
  const state = await loadState();
  const active = await detectActiveProfile();
  const settings = await loadSettings();
  const profile = profiles.find((p) => p.id === active);

  console.log(`active_profile=${active ?? "unknown"}`);
  console.log(`settings_path=${settingsPath}`);
  console.log(`model=${settings.env?.ANTHROPIC_MODEL ?? "<unset>"}`);
  console.log(`base_url=${settings.env?.ANTHROPIC_BASE_URL ?? "<unset>"}`);
  console.log(`managed_token_env=${profile?.tokenEnvVar ?? "<unset>"}`);
  console.log(`proxy_running=${state.proxyPid ? await isProxyRunning() : false}`);
  console.log(`proxy_port=${state.proxyPort ?? "<none>"}`);
  console.log(`proxy_pid=${state.proxyPid ?? "<none>"}`);
};

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

const smokeTest = async (profile: ClaudeProfile) => {
  const env = {
    ...process.env,
    ...buildManagedEnv(profile),
    CLAUDE_CODE_GIT_BASH_PATH:
      getUserEnv("CLAUDE_CODE_GIT_BASH_PATH") ||
      process.env.CLAUDE_CODE_GIT_BASH_PATH,
  } satisfies NodeJS.ProcessEnv;

  const result = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      "sonnet",
      "--max-budget-usd",
      "0.05",
      "Reply with OK only",
    ],
    {
      env,
      encoding: "utf8",
    },
  );

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const combined = `${stdout}\n${stderr}`;

  return {
    ok: result.status === 0 && stdout === "OK",
    reachedProvider:
      /insufficient balance|request_id|api_error|Exceeded USD budget/i.test(
        combined,
      ),
    stdout,
    stderr,
  };
};

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

const launchTui = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Interactive TUI mode requires a real TTY. Use `bun run switcher` or one of the `--apply` commands.",
    );
    process.exit(1);
  }

  // Auto-start proxy if efficiency is active but proxy is dead
  const state = await loadState();
  if (state.activeProfile === "efficiency" && state.proxyPid && !(await isProxyRunning())) {
    console.log("Efficiency mode was active but proxy is not running. Restarting proxy...");
    await startProxy();
  }

  const activeProfile = await detectActiveProfile();
  const renderer = await createCliRenderer({
    exitSignals: ["SIGINT", "SIGTERM"],
  });

  const title = new TextRenderable(renderer, {
    id: "title",
    content: "Claude Code Model Switcher",
    fg: "#7dd3fc",
    position: "absolute",
    left: 3,
    top: 1,
  });

  const subtitle = new TextRenderable(renderer, {
    id: "subtitle",
    content: `Current: ${activeProfile ?? "unknown"} | Enter to apply | Ctrl+C to exit`,
    fg: "#94a3b8",
    position: "absolute",
    left: 3,
    top: 3,
  });

  const menu = new SelectRenderable(renderer, {
    id: "profile-menu",
    width: 80,
    height: 12,
    position: "absolute",
    left: 3,
    top: 5,
    options: [
      ...profiles.map((profile) => ({
        name: `${profile.name}${profile.id === activeProfile ? " (active)" : ""}`,
        description: `${profile.provider} | ${profile.note}`,
      })),
      { name: "Exit", description: "Close without changing the active profile" },
    ],
  });

  menu.on(SelectRenderableEvents.ITEM_SELECTED, async (index) => {
    if (index >= profiles.length) {
      console.log("No changes made.");
      await renderer.destroy();
      process.exit(0);
    }

    const profile = profiles[index];
    await renderer.destroy();

    await applyProfile(profile);
    const state = await loadState();

    console.log(`Switched Claude Code to ${profile.name}.`);
    console.log(`Updated ${settingsPath}`);
    if (profile.id === "efficiency") {
      console.log(`Proxy running on port ${PROXY_PORT} (PID ${state.proxyPid}).`);
    }
    console.log("Open a new terminal window before starting a new Claude session.");

    process.exit(0);
  });

  renderer.root.add(title);
  renderer.root.add(subtitle);
  renderer.root.add(menu);
  menu.focus();

  process.on("uncaughtException", (error) => {
    renderer.destroy();
    console.error(error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    renderer.destroy();
    console.error(reason);
    process.exit(1);
  });
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  const applyId = parseArgValue("--apply");
  const shouldPrintStatus = hasFlag("--status");
  const shouldSmokeTestFlag = hasFlag("--smoke-test");
  const shouldExitShell = hasFlag("--exit-shell");
  const shouldStartProxy = hasFlag("--proxy-start");
  const shouldStopProxy = hasFlag("--proxy-stop");

  // Proxy-only commands
  if (shouldStopProxy) {
    await stopProxy();
    return;
  }

  if (shouldStartProxy) {
    const state = await loadState();
    if (state.activeProfile !== "efficiency") {
      console.log("Proxy start is only needed for efficiency mode.");
    }
    await startProxy();
    return;
  }

  // Ensure proxy is running if efficiency mode is active (idle recovery)
  const state = await loadState();
  if (state.activeProfile === "efficiency" && state.proxyPid && !(await isProxyRunning())) {
    console.log("Proxy was not running for efficiency mode. Restarting...");
    await startProxy();
  }

  if (shouldPrintStatus) {
    await printStatus();
    return;
  }

  if (applyId) {
    const profile = resolveProfile(applyId);
    await applyProfile(profile);
    const newState = await loadState();

    console.log(`Switched Claude Code to ${profile.name}.`);

    if (profile.id === "efficiency") {
      console.log(`Proxy running on port ${PROXY_PORT} (PID ${newState.proxyPid}).`);
      console.log("Opus tier → GLM 5.1 | Sonnet/Haiku tier → MiniMax M2.7");
    }

    if (shouldSmokeTestFlag) {
      const result = await smokeTest(profile);
      if (result.ok) {
        console.log("Smoke test: OK");
        return;
      }
      if (result.reachedProvider) {
        console.log("Smoke test: provider reached, but request blocked by quota/billing limits.");
        if (result.stderr || result.stdout) console.log(result.stderr || result.stdout);
        return;
      }
      throw new Error(result.stderr || result.stdout || `Smoke test failed for ${profile.id}`);
    }
    return;
  }

  if (shouldExitShell) {
    await launchTui();
    return;
  }

  await launchTui();
};

await main();
