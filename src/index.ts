import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { DataStore } from "./data/db.js";
import { RepoStore } from "./repo/clone.js";
import { RepoPool } from "./repo/pool.js";
import { buildServer } from "./server.js";
import { startHttp, type HttpHandle } from "./http.js";
import { log } from "./util/log.js";

/** Hard cap on shutdown: never let a slow cleanup outlive the orchestrator's grace period. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new DataStore(cfg);
  const stopRefresh = store.startAutoRefresh();

  // RepoStore resolves indexed "owner/repo" names to their real clone URL + branch.
  const repos = new RepoStore(cfg.clone, async (name) => {
    await store.ready();
    return store.getRepoByName(name);
  });

  // Reap clone directories stranded by an ungraceful exit (crash, OOM kill).
  if (cfg.clone.enabled) {
    void repos.sweepOrphans().catch((err) => log.warn(`clone sweep failed: ${(err as Error).message}`));
  }

  // Warm the always-cloned pool of top repos in the background (repo_grep_all).
  const pool = new RepoPool(cfg.clone.pool, cfg.clone.dir, repos, store, cfg.refreshTtlMs);
  const stopPool = pool.start();

  // Begin fetching data immediately so the first request is fast; don't block startup.
  store.ready().then(
    () => log(`data ready (release ${store.currentTag})`),
    (err) => log(`initial data load failed (will retry on first request): ${(err as Error).message}`),
  );

  let httpHandle: HttpHandle | undefined;
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    // If cleanup wedges (a slow rm -rf, a stuck connection), exit anyway rather
    // than waiting to be SIGKILLed with the work half-done.
    const watchdog = setTimeout(() => {
      log.warn(`shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref?.();

    void (async () => {
      stopRefresh();
      stopPool();
      try {
        await httpHandle?.shutdown();
      } catch (err) {
        log.warn(`http shutdown failed: ${(err as Error).message}`);
      }
      try {
        await repos.cleanupAll();
      } catch (err) {
        log.warn(`clone cleanup failed: ${(err as Error).message}`);
      }
      store.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (cfg.transport === "http") {
    httpHandle = await startHttp(cfg, store, repos, pool);
  } else {
    const server = buildServer(store, repos, pool);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log(
      `kubesearch-mcp ready on stdio (clone ${cfg.clone.enabled ? "enabled" : "disabled"}, pool ${pool.enabled ? `${pool.status().size} repos` : "disabled"})`,
    );
  }
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
