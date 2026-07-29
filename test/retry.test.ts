import { describe, expect, it } from "vitest";
import { HttpStatusError, withRetry } from "../src/util/retry.js";

describe("withRetry", () => {
  it("retries until the operation succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "success";
      },
      { attempts: 3, baseMs: 0 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("does not retry when the error is not retryable", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new HttpStatusError("HTTP 403", 403);
        },
        { attempts: 3, baseMs: 0, retryable: (err) => !(err instanceof HttpStatusError) },
      ),
    ).rejects.toThrow("HTTP 403");
    expect(attempts).toBe(1);
  });

  it("throws the last error after exhausting attempts", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error(`fail ${attempts}`);
        },
        { attempts: 3, baseMs: 0 },
      ),
    ).rejects.toThrow("fail 3");
    expect(attempts).toBe(3);
  });
});
