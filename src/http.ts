import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { DataStore } from "./data/db.js";
import type { RepoStore } from "./repo/clone.js";
import { buildServer } from "./server.js";
import { log } from "./util/log.js";

/** How long to let in-flight responses finish before forcing sockets closed. */
const DRAIN_MS = 2_000;

class BodyTooLargeError extends Error {}
class MalformedJsonError extends Error {}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

/** A running HTTP server plus the way to stop it without cutting off clients. */
export interface HttpHandle {
  server: http.Server;
  shutdown: () => Promise<void>;
}

function originAllowed(cfg: Config, origin: string | undefined): boolean {
  // Origin is only sent by browsers; a missing one means a normal MCP client.
  if (cfg.allowedOrigins.length === 0 || !origin) return true;
  return cfg.allowedOrigins.includes(origin.toLowerCase());
}

function hostAllowed(cfg: Config, host: string | undefined): boolean {
  if (cfg.allowedHosts.length === 0) return true;
  if (!host) return false;
  const bare = host.toLowerCase().replace(/:\d+$/, "");
  return cfg.allowedHosts.includes(bare) || cfg.allowedHosts.includes(host.toLowerCase());
}

function setCors(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (cfg.allowedOrigins.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && originAllowed(cfg, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function isAuthorized(cfg: Config, req: http.IncomingMessage): boolean {
  if (cfg.authTokens.length === 0) return true;
  const header = req.headers["authorization"];
  return cfg.authTokens.some((token) => header === `Bearer ${token}`);
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new MalformedJsonError("request body is not valid JSON");
  }
}

/**
 * Start a Streamable HTTP MCP server with in-memory session management, the
 * transport shape standard MCP clients (Claude Code/Desktop) expect over HTTP.
 */
export function startHttp(cfg: Config, store: DataStore, repos: RepoStore): Promise<HttpHandle> {
  const sessions = new Map<string, Session>();

  function dropSession(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    void Promise.resolve(session.server.close()).catch(() => {});
  }

  // Sessions are only removed on an explicit DELETE or a clean transport close,
  // so a client that simply vanishes would otherwise pin a transport and a whole
  // McpServer for the life of the process.
  const reaperIntervalMs = Math.max(1_000, Math.min(60_000, cfg.sessionTtlMs));
  const reaper = setInterval(() => {
    const cutoff = Date.now() - cfg.sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        log.debug(`reaping idle session ${id}`);
        void Promise.resolve(session.transport.close()).catch(() => {});
        dropSession(id);
      }
    }
  }, reaperIntervalMs);
  reaper.unref?.();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    setCors(cfg, req, res);
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Liveness: the process is up. Deliberately unconditional — a slow data
    // load must not get the container restarted.
    if (url.pathname === "/healthz" || url.pathname === "/") {
      sendJson(res, 200, { status: "ok", tag: store.currentTag });
      return;
    }
    // Readiness: queries will actually succeed. Use this for load-balancer and
    // Kubernetes readiness probes.
    if (url.pathname === "/readyz") {
      const ready = store.currentTag !== "unknown";
      sendJson(res, ready ? 200 : 503, { status: ready ? "ready" : "loading", tag: store.currentTag });
      return;
    }
    if (url.pathname !== "/mcp") {
      rpcError(res, 404, -32601, "Not found");
      return;
    }
    if (!hostAllowed(cfg, req.headers.host)) {
      log.warn(`rejected Host header "${req.headers.host ?? ""}" from ${req.socket.remoteAddress ?? "unknown"}`);
      rpcError(res, 403, -32000, "Host not allowed");
      return;
    }
    if (!originAllowed(cfg, req.headers.origin)) {
      log.warn(`rejected Origin "${req.headers.origin ?? ""}" from ${req.socket.remoteAddress ?? "unknown"}`);
      rpcError(res, 403, -32000, "Origin not allowed");
      return;
    }
    if (!isAuthorized(cfg, req)) {
      log.warn(`unauthorized ${req.method} ${url.pathname} from ${req.socket.remoteAddress ?? "unknown"}`);
      res.setHeader("WWW-Authenticate", "Bearer");
      rpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) existing.lastSeen = Date.now();

    if (req.method === "GET" || req.method === "DELETE") {
      // SSE stream resumption / session termination — must reference a live session.
      if (!existing) {
        rpcError(res, 400, -32000, "Unknown or missing session id");
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req, cfg.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        rpcError(res, 413, -32000, "Request body too large");
        return;
      }
      if (err instanceof MalformedJsonError) {
        rpcError(res, 400, -32700, "Parse error");
        return;
      }
      throw err;
    }

    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      rpcError(res, 400, -32000, "No valid session id; send an initialize request first");
      return;
    }
    // Refuse rather than evict: dropping a live client to make room for a new
    // one trades a visible error for a mysterious one.
    if (sessions.size >= cfg.maxSessions) {
      log.warn(`refusing new session: ${sessions.size} already open (MCP_MAX_SESSIONS)`);
      rpcError(res, 503, -32000, "Too many active sessions");
      return;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, { transport, server, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) dropSession(transport.sessionId);
    };
    const server = buildServer(store, repos);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer((req, res) => {
    const start = performance.now(); // monotonic — immune to wall-clock skew
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Skip access logs for health checks and CORS preflight — pure noise.
    const skipAccessLog = req.method === "OPTIONS" || pathname === "/healthz" || pathname === "/readyz" || pathname === "/";
    if (!skipAccessLog) {
      res.on("finish", () => {
        const sid = req.headers["mcp-session-id"];
        const session = typeof sid === "string" ? ` session=${sid}` : "";
        log.info(`${req.method} ${pathname} -> ${res.statusCode} (${Math.round(performance.now() - start)}ms)${session}`);
      });
    }
    void handle(req, res).catch((err) => {
      log.error(`http handler error: ${(err as Error).message}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
    });
  });

  async function shutdown(): Promise<void> {
    clearInterval(reaper);
    const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    httpServer.closeIdleConnections();
    // Ending the transports terminates their SSE streams, which is what keeps
    // otherwise-idle connections open.
    await Promise.all(
      [...sessions.keys()].map(async (id) => {
        const session = sessions.get(id);
        if (!session) return;
        try {
          await session.transport.close();
        } catch {
          /* already gone */
        }
        dropSession(id);
      }),
    );
    const drain = setTimeout(() => httpServer.closeAllConnections(), DRAIN_MS);
    drain.unref?.();
    await closed;
    clearTimeout(drain);
  }

  return new Promise((resolve) => {
    httpServer.listen(cfg.port, cfg.host, () => {
      const auth = cfg.authTokens.length === 0 ? "off" : `on (${cfg.authTokens.length} token${cfg.authTokens.length === 1 ? "" : "s"})`;
      const { port } = httpServer.address() as { port: number };
      log(`kubesearch-mcp HTTP listening on http://${cfg.host}:${port}/mcp (auth ${auth})`);
      const loopback = cfg.host === "127.0.0.1" || cfg.host === "::1" || cfg.host === "localhost";
      if (!loopback && cfg.authTokens.length === 0) {
        log.warn(
          `listening on ${cfg.host} with authentication disabled and CORS open — set MCP_AUTH_TOKEN ` +
            `(and MCP_ALLOWED_ORIGINS) before exposing this beyond a trusted network.`,
        );
      }
      resolve({ server: httpServer, shutdown });
    });
  });
}
