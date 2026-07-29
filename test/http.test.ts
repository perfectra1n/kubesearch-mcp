import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DataStore } from "../src/data/db.js";
import { RepoStore } from "../src/repo/clone.js";
import { startHttp } from "../src/http.js";
import { makeFixtureCacheDir } from "./fixtures.js";

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
};

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

interface TestServer {
  base: string;
  store: DataStore;
  shutdown: () => Promise<void>;
}

let running: TestServer[] = [];

async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const fx = makeFixtureCacheDir("test");
  const cfg = loadConfig({
    MCP_TRANSPORT: "http",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: "0",
    KUBESEARCH_CACHE_DIR: fx.cacheDir,
    KUBESEARCH_REFRESH_HOURS: "0",
    KUBESEARCH_ENABLE_CLONE: "false",
    ...env,
  } as NodeJS.ProcessEnv);
  const store = new DataStore(cfg);
  const repos = new RepoStore(cfg.clone, async () => null);
  const handle = await startHttp(cfg, store, repos);
  const { port } = handle.server.address() as AddressInfo;

  const server: TestServer = {
    base: `http://127.0.0.1:${port}`,
    store,
    shutdown: async () => {
      await handle.shutdown();
      store.close();
      fx.cleanup();
    },
  };
  running.push(server);
  return server;
}

afterEach(async () => {
  for (const s of running) await s.shutdown().catch(() => {});
  running = [];
});

async function initSession(base: string): Promise<Response> {
  return fetch(`${base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });
}

describe("health endpoints", () => {
  it("separates liveness from readiness", async () => {
    const s = await startTestServer();

    // Data hasn't loaded yet: alive, but not ready to serve queries.
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.base}/readyz`)).status).toBe(503);

    await s.store.ready();

    expect((await fetch(`${s.base}/readyz`)).status).toBe(200);
    const body = (await (await fetch(`${s.base}/readyz`)).json()) as { tag: string };
    expect(body.tag).toBe("test");
  });
});

describe("request limits", () => {
  it("rejects a body over the configured size with 413", async () => {
    const s = await startTestServer({ MCP_MAX_BODY_BYTES: "1024" });

    const res = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ padding: "x".repeat(4096) }),
    });

    expect(res.status).toBe(413);
  });

  it("rejects malformed JSON with 400 rather than a generic 500", async () => {
    const s = await startTestServer();

    const res = await fetch(`${s.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{ not json" });

    expect(res.status).toBe(400);
  });
});

describe("session management", () => {
  it("refuses new sessions once the cap is reached", async () => {
    const s = await startTestServer({ MCP_MAX_SESSIONS: "1" });

    const first = await initSession(s.base);
    expect(first.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeTruthy();
    await first.text();

    const second = await initSession(s.base);
    expect(second.status).toBe(503);
  });

  it("reaps a session that goes idle", async () => {
    // 0.01 min = 600ms idle TTL; the reaper ticks at least once a second.
    const s = await startTestServer({ MCP_SESSION_TTL_MINUTES: "0.01" });

    const init = await initSession(s.base);
    const sessionId = init.headers.get("mcp-session-id")!;
    await init.text();

    const ping = async (): Promise<number> => {
      const res = await fetch(`${s.base}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      });
      await res.text();
      return res.status;
    };

    // Still live right after initialize...
    expect(await ping()).toBe(200);

    // ...but gone once it has been idle past the TTL. Sleep without polling:
    // every request counts as activity and would keep the session alive.
    await new Promise((r) => setTimeout(r, 2500));

    expect(await ping()).toBe(400);
  }, 15000);
});

describe("origin and host guards", () => {
  it("allows any origin by default", async () => {
    const s = await startTestServer();
    const res = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "https://anywhere.test" },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("rejects an unlisted origin once an allowlist is configured", async () => {
    const s = await startTestServer({ MCP_ALLOWED_ORIGINS: "https://good.test" });

    const blocked = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "https://evil.test" },
      body: JSON.stringify(INIT_BODY),
    });
    expect(blocked.status).toBe(403);

    const allowed = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "https://good.test" },
      body: JSON.stringify(INIT_BODY),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://good.test");
    await allowed.text();
  });

  it("rejects an unlisted Host header once an allowlist is configured", async () => {
    const s = await startTestServer({ MCP_ALLOWED_HOSTS: "mcp.example.test" });

    const blocked = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, host: "attacker.test" },
      body: JSON.stringify(INIT_BODY),
    });

    expect(blocked.status).toBe(403);
  });
});

describe("graceful shutdown", () => {
  it("stops listening and releases the port", async () => {
    const s = await startTestServer();
    const base = s.base;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    await s.shutdown();
    running = running.filter((r) => r !== s);

    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it("completes even with an open session", async () => {
    const s = await startTestServer();
    const init = await initSession(s.base);
    await init.text();

    await expect(s.shutdown()).resolves.toBeUndefined();
    running = running.filter((r) => r !== s);
  });
});
