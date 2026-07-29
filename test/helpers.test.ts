import { describe, expect, it } from "vitest";
import { fail, guarded, ok } from "../src/tools/helpers.js";

describe("ok", () => {
  it("emits compact text that parses back to structuredContent", () => {
    const result = ok({ a: 1, nested: { b: [1, 2] } });
    const text = result.content[0]!.text;

    expect(text).toBe('{"a":1,"nested":{"b":[1,2]}}');
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });
});

describe("fail", () => {
  it("marks the result as an error with a plain-text message", () => {
    const result = fail("nope");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("nope");
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("guarded", () => {
  it("returns structuredContent on success, like the search tools", async () => {
    const result = await guarded(async () => ({ handle: "abc", removed: true }));
    expect(result.structuredContent).toEqual({ handle: "abc", removed: true });
    expect(result.content[0]!.text).toBe('{"handle":"abc","removed":true}');
    expect(result.isError).toBeUndefined();
  });

  it("converts a thrown error into an error result", async () => {
    const result = await guarded(async () => {
      throw new Error("clone failed");
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("clone failed");
  });
});
