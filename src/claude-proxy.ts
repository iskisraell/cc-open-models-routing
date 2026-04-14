/**
 * claude-proxy.ts
 *
 * HTTP proxy that routes Claude Code requests to different AI providers
 * based on the model name in the request body.
 *
 * Routing:
 *   - MiniMax-*  → MiniMax (https://api.minimax.io/anthropic)
 *   - glm-* / all others → Z.AI (https://api.z.ai/api/anthropic)
 *
 * Usage:
 *   bun run src/claude-proxy.ts
 *
 * Environment (set by claude-model-switcher.ts when spawning):
 *   PROXY_PORT        — port to listen on (default 3472)
 *   ZAI_API_TOKEN     — Z.AI API token
 *   MINIMAX_API_TOKEN — MiniMax API token
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "3472", 10);

// Tokens are re-read at request time so env var changes (User scope)
// take effect without restarting the proxy
const getTokens = () => {
  const { spawnSync } = require("node:child_process");
  const run = (cmd: string) => {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
    return (r.stdout ?? "").trim();
  };
  return {
    zai: run(`[System.Environment]::GetEnvironmentVariable('CLAUDE_PROFILE_ZAI_TOKEN','User')`),
    minimax: run(`[System.Environment]::GetEnvironmentVariable('CLAUDE_PROFILE_MINIMAX_TOKEN','User')`),
  };
};

const UPSTREAMS: Record<string, { url: string; token: string }> = {
  zai: {
    url: "https://api.z.ai/api/anthropic",
    token: "", // filled dynamically
  },
  minimax: {
    url: "https://api.minimax.io/anthropic",
    token: "", // filled dynamically
  },
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log(`[proxy] Claude routing proxy listening on http://localhost:${PROXY_PORT}`);
console.log(`[proxy] Tokens are re-read from User env on every request (dynamic)`);

/** Determine upstream key from the model name in the request body */
const routeModel = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { model?: string };
    const model: string = parsed.model ?? "";
    if (model.toLowerCase().startsWith("minimax")) return "minimax";
    return "zai"; // glm-* and everything else defaults to z.ai
  } catch {
    return "zai";
  }
};

// ---------------------------------------------------------------------------
// HTTP Server (Bun-native)
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PROXY_PORT,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json({ status: "ok", port: PROXY_PORT });
    }

    // Only proxy Anthropic-compatible /v1/* endpoints
    if (!url.pathname.startsWith("/v1/")) {
      return Response.json(
        { error: "Not found — this proxy only handles /v1/* requests" },
        { status: 404 },
      );
    }

    // Collect body
    const body = await req.text();

    // Route to upstream based on model (tokens re-read per request)
    const upstreamKey = routeModel(body);
    const { zai: zaiToken, minimax: minimaxToken } = getTokens();
    const token = upstreamKey === "minimax" ? minimaxToken : zaiToken;
    const upstream = UPSTREAMS[upstreamKey];

    console.log(`[proxy] request body model: ${JSON.parse(body)?.model ?? "unknown"} → ${upstreamKey}`);
    console.log(`[proxy] sending Authorization: Bearer ${token?.slice(0,15) ?? "MISSING"}...`);

    if (!token) {
      return Response.json(
        { error: `Missing API token for upstream: ${upstreamKey}` },
        { status: 502 },
      );
    }

    // Build upstream URL
    const upstreamUrl = `${upstream.url}${url.pathname}${url.search}`;

    // Strip encoding headers so upstream returns uncompressed response
    // (Claude Code handles decompression itself)
    // Also strip existing auth headers from client - we set our own
    const headers: Record<string, string> = {};
    req.headers.forEach((value: string, key: string) => {
      const lk = key.toLowerCase();
      if (lk === "host" || lk === "accept-encoding" || lk === "authorization" || lk === "x-api-key") return;
      headers[key] = value;
    });
    const upstreamToken = upstreamKey === "minimax" ? minimaxToken : zaiToken;
    headers["Authorization"] = `Bearer ${upstreamToken}`;
    headers["X-Api-Key"] = upstreamToken;
    headers["Connection"] = "close"; // avoid connection reuse issues

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
      });

      // Pass through upstream response as-is
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: upstreamRes.headers,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown upstream error";
      console.error(`[proxy] Upstream error (${upstreamKey}): ${message}`);
      return Response.json({ error: message }, { status: 502 });
    }
  },

  error(err: Error) {
    console.error(`[proxy] Server error: ${err.message}`);
    return Response.json({ error: err.message }, { status: 500 });
  },
});

console.log(`[proxy] Claude routing proxy listening on http://localhost:${server.port}`);
console.log(`[proxy] Tokens are re-read from User env on every request (dynamic)`);
console.log(`[proxy] Routing:        MiniMax-* → MiniMax | glm-* / others → Z.AI`);
