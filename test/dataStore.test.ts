import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { DataStore } from "../src/data/db.js";
import { makeFixtureCacheDir } from "./fixtures.js";

const HOUR = 3600_000;
const MINUTE = 60_000;

type RefreshProbe = { maybeRefresh(): Promise<void> };

function testConfig(cacheDir: string): Config {
  return loadConfig({
    KUBESEARCH_CACHE_DIR: cacheDir,
    KUBESEARCH_ENABLE_CLONE: "false",
  } as NodeJS.ProcessEnv);
}

function releaseResponse(tag: string, etag?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (etag) headers.set("etag", etag);
  return new Response(JSON.stringify([{ tag_name: tag, assets: [{ name: "repos.db" }] }]), { status: 200, headers });
}

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DataStore", () => {
  it("loads from a fresh cache without touching the network", async () => {
    const { cacheDir, cleanup } = makeFixtureCacheDir("test");
    const fetchMock = vi.fn(async () => {
      throw new Error("network should not be used");
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);

    await store.ready();
    expect(store.currentTag).toBe("test");
    expect(store.status().reposIndexed).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failed refresh after a short backoff instead of the full TTL", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-07-29T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    const { cacheDir, cleanup } = makeFixtureCacheDir("test", { fetchedAt: t0 });
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    const probe = store as unknown as RefreshProbe;
    await store.ready();
    expect(fetchMock).not.toHaveBeenCalled();

    // TTL (24h) elapses; the refresh cycle fails (all transport retries exhausted).
    vi.setSystemTime(t0 + 24 * HOUR + MINUTE);
    const first = probe.maybeRefresh();
    await vi.runAllTimersAsync(); // drive the transport-retry backoff sleeps
    await first;
    const callsAfterFailure = fetchMock.mock.calls.length;
    expect(callsAfterFailure).toBeGreaterThan(0);

    // ~4 minutes later: still inside the 5-minute failure backoff — no attempt.
    vi.setSystemTime(t0 + 24 * HOUR + 5 * MINUTE);
    await probe.maybeRefresh();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailure);

    // 2 more minutes: past the backoff — a new attempt fires (not 24h later).
    vi.setSystemTime(t0 + 24 * HOUR + 7 * MINUTE);
    const second = probe.maybeRefresh();
    await vi.runAllTimersAsync();
    await second;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });

  it("resets the failure backoff after a successful refresh", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-07-29T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    const { cacheDir, cleanup } = makeFixtureCacheDir("test", { fetchedAt: t0 });
    // First refresh cycle fails entirely (3 transport attempts), then succeed.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 3) throw new TypeError("fetch failed");
      return releaseResponse("test");
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    const probe = store as unknown as RefreshProbe;
    await store.ready();

    vi.setSystemTime(t0 + 24 * HOUR + MINUTE);
    const failed = probe.maybeRefresh();
    await vi.runAllTimersAsync();
    await failed;
    expect(fetchMock.mock.calls.length).toBe(3); // one failed cycle

    vi.setSystemTime(t0 + 24 * HOUR + 7 * MINUTE);
    const succeeded = probe.maybeRefresh();
    await vi.runAllTimersAsync();
    await succeeded;
    expect(fetchMock.mock.calls.length).toBe(4); // successful attempt (same tag)

    // Success restores the full TTL: ten more minutes later, no new attempt.
    vi.setSystemTime(t0 + 24 * HOUR + 17 * MINUTE);
    await probe.maybeRefresh();
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it("persists the release-list ETag in meta.json when resolving with a stale cache", async () => {
    const t0 = Date.now();
    const { cacheDir, cleanup } = makeFixtureCacheDir("test", { fetchedAt: t0 - 25 * HOUR });
    const fetchMock = vi.fn(async () => releaseResponse("test", 'W/"abc"'));
    vi.stubGlobal("fetch", fetchMock);

    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    await store.ready();

    expect(store.currentTag).toBe("test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf-8")) as { etag?: string };
    expect(meta.etag).toBe('W/"abc"');
  });

  it("creates url lookup indexes on the extended database during load", async () => {
    const { cacheDir, cleanup } = makeFixtureCacheDir("test");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network should not be used");
    }));
    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    await store.ready();

    const names = (
      store.database.prepare("select name from ext.sqlite_master where type='index'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toContain("idx_fhrv_url");
    expect(names).toContain("idx_ahav_url");
  });

  it("getValues round-trips parsed values for known urls", async () => {
    const { cacheDir, cleanup } = makeFixtureCacheDir("test");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network should not be used");
    }));
    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    await store.ready();

    const fluxUrl = "https://github.com/onedr0p/home-ops/blob/main/k8s/cert-manager/helmrelease.yaml";
    const carpenikeUrl = "https://github.com/carpenike/k8s-gitops/blob/main/k8s/cert-manager/hr.yaml";
    const values = store.getValues([fluxUrl, carpenikeUrl]);
    expect(values.size).toBe(2);
    expect((values.get(carpenikeUrl) as { replicaCount: number }).replicaCount).toBe(1);
  });

  it("applies performance pragmas to the connection", async () => {
    const { cacheDir, cleanup } = makeFixtureCacheDir("test");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network should not be used");
    }));
    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    await store.ready();

    expect(store.database.pragma("temp_store", { simple: true })).toBe(2);
  });

  it("sweeps stale tmp files during load", async () => {
    const { cacheDir, cleanup } = makeFixtureCacheDir("test");
    const stale = path.join(cacheDir, "repos-old.db.tmp-999");
    fs.writeFileSync(stale, "x");
    const old = (Date.now() - 2 * HOUR) / 1000;
    fs.utimesSync(stale, old, old);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network should not be used");
    }));

    const store = new DataStore(testConfig(cacheDir));
    cleanups.push(() => store.close(), cleanup);
    await store.ready();

    expect(fs.existsSync(stale)).toBe(false);
  });
});
