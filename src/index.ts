import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { DataStore } from "./data/db.js";
import { buildServer } from "./server.js";
import { startHttp } from "./http.js";
import { log } from "./util/log.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new DataStore(cfg);
  store.startAutoRefresh();

  // Begin fetching data immediately so the first request is fast; don't block startup.
  store.ready().then(
    () => log(`data ready (release ${store.currentTag})`),
    (err) => log(`initial data load failed (will retry on first request): ${(err as Error).message}`),
  );

  const shutdown = (signal: string): void => {
    log(`received ${signal}, shutting down`);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (cfg.transport === "http") {
    await startHttp(cfg, store);
  } else {
    const server = buildServer(store);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("kubesearch-mcp ready on stdio");
  }
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
