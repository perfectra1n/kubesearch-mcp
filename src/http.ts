import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { DataStore } from "./data/db.js";
import { buildServer } from "./server.js";
import { log } from "./util/log.js";

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
  if (!cfg.authToken) return true;
  return req.headers["authorization"] === `Bearer ${cfg.authToken}`;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/**
 * Start a Streamable HTTP MCP server with in-memory session management, the
 * transport shape standard MCP clients (Claude Code/Desktop) expect over HTTP.
 */
export function startHttp(cfg: Config, store: DataStore): Promise<http.Server> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    setCors(res);
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/healthz" || url.pathname === "/") {
      sendJson(res, 200, { status: "ok", tag: store.currentTag });
      return;
    }
    if (url.pathname !== "/mcp") {
      rpcError(res, 404, -32601, "Not found");
      return;
    }
    if (!isAuthorized(cfg, req)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      rpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

    if (req.method === "GET" || req.method === "DELETE") {
      // SSE stream resumption / session termination — must reference a live session.
      if (!existing) {
        rpcError(res, 400, -32000, "Unknown or missing session id");
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
      return;
    }

    const body = await readBody(req);

    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      rpcError(res, 400, -32000, "No valid session id; send an initialize request first");
      return;
    }

    // New session: build a server + transport and register on initialize.
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const server = buildServer(store);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`http handler error: ${(err as Error).message}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(cfg.port, cfg.host, () => {
      log(`kubesearch-mcp HTTP listening on http://${cfg.host}:${cfg.port}/mcp (auth ${cfg.authToken ? "on" : "off"})`);
      resolve(httpServer);
    });
  });
}
