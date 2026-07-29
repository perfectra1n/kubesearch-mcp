import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLatestTag } from "../src/data/releases.js";

const NO_BACKOFF = { baseMs: 0 };

function releaseList(): unknown {
  return [
    { tag_name: "v2-no-assets", assets: [{ name: "something-else.tar" }] },
    { tag_name: "v1", assets: [{ name: "repos.db" }, { name: "repos-extended.db" }] },
  ];
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.etag) headers.set("etag", init.etag);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveLatestTag", () => {
  it("resolves the newest tag that carries the repos.db asset", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(releaseList(), { etag: 'W/"abc"' }));
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveLatestTag("owner/repo", undefined, undefined, NO_BACKOFF);
    expect(resolved.tag).toBe("v1");
    expect(resolved.etag).toBe('W/"abc"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 403 (rate limit)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "rate limited" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLatestTag("owner/repo", undefined, undefined, NO_BACKOFF)).rejects.toThrow(/rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(releaseList()));
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveLatestTag("owner/repo", undefined, undefined, NO_BACKOFF);
    expect(resolved.tag).toBe("v1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends If-None-Match and short-circuits on 304", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('W/"abc"');
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveLatestTag("owner/repo", undefined, { tag: "v1", etag: 'W/"abc"' }, NO_BACKOFF);
    expect(resolved.tag).toBe("v1");
    expect(resolved.etag).toBe('W/"abc"');
    expect(resolved.notModified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
