import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import type { DataStore } from "./data/db.js";
import { buildServer } from "./server.js";
import { log } from "./util/log.js";

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
}

function isAuthorized(cfg: Config, req: http.IncomingMessage): boolean {
  if (!cfg.authToken) return true;
  const header = req.headers["authorization"];
  return typeof header === "string" && header === `Bearer ${cfg.authToken}`;
}

/**
 * Start a Streamable HTTP MCP server using stateless per-request transports
 * (ideal for a read-only, horizontally-scalable container deployment).
 */
export function startHttp(cfg: Config, store: DataStore): Promise<http.Server> {
  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`http handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    setCors(res);
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/healthz" || url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tag: store.currentTag }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Not found" }, id: null }));
      return;
    }
    if (!isAuthorized(cfg, req)) {
      unauthorized(res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed; use POST" }, id: null }));
      return;
    }

    // Stateless: a fresh server + transport per request.
    const server = buildServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  return new Promise((resolve) => {
    httpServer.listen(cfg.port, cfg.host, () => {
      log(`kubesearch-mcp HTTP listening on http://${cfg.host}:${cfg.port}/mcp (auth ${cfg.authToken ? "on" : "off"})`);
      resolve(httpServer);
    });
  });
}
