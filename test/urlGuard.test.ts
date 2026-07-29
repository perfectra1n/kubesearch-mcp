import { describe, expect, it } from "vitest";
import { isPrivateHost, validateCloneUrl, CloneValidationError } from "../src/repo/urlGuard.js";
import type { CloneConfig } from "../src/config.js";

const base: CloneConfig = {
  enabled: true,
  allowedHosts: [],
  allowPrivate: false,
  dir: "/tmp/clones",
  ttlMs: 60000,
  refreshOnClone: true,
  maxRepos: 5,
  maxConcurrent: 2,
  maxBytes: 100 * 1024 * 1024,
  timeoutMs: 60000,
};

describe("validateCloneUrl", () => {
  it("accepts a normal https GitHub URL", () => {
    expect(validateCloneUrl("https://github.com/onedr0p/home-ops", base).url).toBe("https://github.com/onedr0p/home-ops");
  });

  it("rejects non-https schemes", () => {
    for (const u of ["http://github.com/a/b", "ssh://git@github.com/a/b", "git://github.com/a/b", "file:///etc/passwd"]) {
      expect(() => validateCloneUrl(u, base)).toThrow(CloneValidationError);
    }
  });

  it("rejects embedded credentials and option-injection", () => {
    expect(() => validateCloneUrl("https://user:pass@github.com/a/b", base)).toThrow(CloneValidationError);
    expect(() => validateCloneUrl("--upload-pack=evil", base)).toThrow(CloneValidationError);
  });

  it("blocks private/loopback/metadata addresses by default", () => {
    for (const u of [
      "https://localhost/a/b",
      "https://127.0.0.1/a/b",
      "https://169.254.169.254/latest",
      "https://10.0.0.5/a/b",
      "https://192.168.1.10/a/b",
      "https://[::1]/a/b",
      "https://gitea.internal/a/b",
    ]) {
      expect(() => validateCloneUrl(u, base), u).toThrow(CloneValidationError);
    }
  });

  it("allows private addresses when allowPrivate is set", () => {
    expect(validateCloneUrl("https://192.168.1.10/a/b", { ...base, allowPrivate: true }).host).toBe("192.168.1.10");
  });

  it("enforces an allowlist when provided", () => {
    const cfg = { ...base, allowedHosts: ["github.com"] };
    expect(validateCloneUrl("https://github.com/a/b", cfg).host).toBe("github.com");
    expect(() => validateCloneUrl("https://gitlab.com/a/b", cfg)).toThrow(CloneValidationError);
  });
});

describe("isPrivateHost", () => {
  it("classifies addresses", () => {
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("github.com")).toBe(false);
    expect(isPrivateHost("172.16.5.4")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("foo.local")).toBe(true);
  });
});
