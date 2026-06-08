import { describe, expect, it } from "vitest";
import { mergeHelmURL, releaseKey } from "../src/domain/releaseKey.js";

describe("releaseKey", () => {
  it("matches the real cert-manager OCI slug", () => {
    expect(releaseKey("oci://ghcr.io/home-operations/charts-mirror/cert-manager", "cert-manager", "cert-manager")).toBe(
      "ghcr.io-home-operations-charts-mirror-cert-manager",
    );
  });

  it("appends release name when it differs from chart (OCI)", () => {
    expect(releaseKey("oci://ghcr.io/home-operations/charts-mirror/cert-manager", "cert-manager", "cert-manager-prod")).toBe(
      "ghcr.io-home-operations-charts-mirror-cert-manager-cert-manager-prod",
    );
  });

  it("appends chart name for helm-repo URLs not ending in the chart name", () => {
    // https://charts.jetstack.io does not end with the chart name
    expect(releaseKey("https://charts.jetstack.io", "cert-manager", "cert-manager")).toBe("charts.jetstack.io-cert-manager");
  });

  it("strips schemes, trailing slashes, and lowercases", () => {
    expect(releaseKey("https://Example.COM/Charts/", "foo", "foo")).toBe("example.com-charts-foo");
  });
});

describe("mergeHelmURL", () => {
  it("canonicalizes the various bjw-s registries", () => {
    const expected = "oci://ghcr.io/bjw-s-labs/charts/";
    expect(mergeHelmURL("https://bjw-s.github.io/helm-charts")).toBe(expected);
    expect(mergeHelmURL("oci://ghcr.io/bjw-s/helm")).toBe(expected);
    expect(mergeHelmURL("oci://ghcr.io/bjw-s-labs/app-template")).toBe(expected);
    expect(mergeHelmURL("oci://ghcr.io/bjw-s-labs/charts")).toBe(expected);
  });

  it("maps known http chart repos to their OCI equivalents", () => {
    expect(mergeHelmURL("https://charts.bitnami.com/bitnami")).toBe("oci://registry-1.docker.io/bitnamicharts/");
    expect(mergeHelmURL("https://kyverno.github.io/kyverno")).toBe("oci://ghcr.io/kyverno/charts/");
  });

  it("passes through unknown URLs unchanged", () => {
    expect(mergeHelmURL("https://charts.jetstack.io")).toBe("https://charts.jetstack.io");
  });
});
