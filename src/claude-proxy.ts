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
const ZAI_TOKEN = process.env.ZAI_API_TOKEN ?? "";
const MINIMAX_TOKEN = process.env.MINIMAX_API_TOKEN ?? "";

interface Upstream {
  url: string;
  token: string;
}

const UPSTREAMS: Record<string, Upstream> = {
  zai: {
    url: "https://api.z.ai/api/anthropic",
    token: ZAI_TOKEN,
  },
  minimax: {
    url: "https://api.minimax.io/anthropic",
    token: MINIMAX_TOKEN,
  },
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

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

    // Route to upstream based on model
    const upstreamKey = routeModel(body);
    const upstream = UPSTREAMS[upstreamKey];

    if (!upstream?.token) {
      return Response.json(
        { error: `Missing API token for upstream: ${upstreamKey}` },
        { status: 502 },
      );
    }

    // Build upstream URL
    const upstreamUrl = new URL(url.pathname + url.search, upstream.url);

    // Clone and clean headers — replace auth with upstream token
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${upstream.token}`);
    headers.set("X-Api-Key", upstream.token);
    headers.delete("host");
    headers.delete("connection"); // let fetch manage keep-alive

    try {
      const upstreamReq = new Request(upstreamUrl.toString(), {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        // @ts-expect-error - duplex is valid in Bun
        duplex: "half",
      });

      const upstreamRes = await fetch(upstreamReq);

      // Stream the response back with same status
      const responseHeaders = new Headers();
      upstreamRes.headers.forEach((value, key) => {
        responseHeaders.set(key, value);
      });

      const stream = upstreamRes.body;

      return new Response(stream, {
        status: upstreamRes.status,
        headers: responseHeaders,
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
console.log(`[proxy] Z.AI token:     ${ZAI_TOKEN ? "✓ set" : "✗ MISSING"}`);
console.log(`[proxy] MiniMax token:  ${MINIMAX_TOKEN ? "✓ set" : "✗ MISSING"}`);
console.log(`[proxy] Routing:        MiniMax-* → MiniMax | glm-* / others → Z.AI`);
