import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Build a tiny, self-contained pair of databases that mirror the real
 * kubesearch.dev schema (metadata DB + extended values DB attached as `ext`),
 * so the domain logic can be tested fully offline.
 */
export function makeFixtureDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kubesearch-fixture-"));
  const mainPath = path.join(dir, "repos.db");
  const extPath = path.join(dir, "repos-extended.db");
  writeFixtureData(mainPath, extPath);

  const db = new Database(mainPath, { readonly: true, fileMustExist: true });
  db.exec(`ATTACH DATABASE '${extPath.replaceAll("'", "''")}' AS ext`);

  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Populate a cache directory the way DataStore expects it on disk
 * (tagged database files + meta.json), so DataStore/HTTP tests run offline.
 */
export function makeFixtureCacheDir(
  tag = "test",
  opts: { fetchedAt?: number; etag?: string } = {},
): { cacheDir: string; cleanup: () => void } {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kubesearch-cache-"));
  writeFixtureData(path.join(cacheDir, `repos-${tag}.db`), path.join(cacheDir, `repos-extended-${tag}.db`));
  const meta: Record<string, unknown> = { tag, fetchedAt: opts.fetchedAt ?? Date.now() };
  if (opts.etag) meta.etag = opts.etag;
  fs.writeFileSync(path.join(cacheDir, "meta.json"), JSON.stringify(meta));
  return {
    cacheDir,
    cleanup: () => fs.rmSync(cacheDir, { recursive: true, force: true }),
  };
}

/** Write the fixture dataset to a pair of database files. */
export function writeFixtureData(mainPath: string, extPath: string): void {
  const main = new Database(mainPath);
  main.exec(`
    CREATE TABLE repo (repo_name text primary key, url text, branch text, stars integer);
    CREATE TABLE flux_helm_release (release_name text NOT NULL, chart_name text NOT NULL, chart_version text NULL,
      namespace text NULL, repo_name text NOT NULL, hajimari_icon text NULL, hajimari_group text NULL,
      chart_ref_kind text NULL, lines number NOT NULL, url text NOT NULL, timestamp text NOT NULL,
      helm_repo_name text NOT NULL, helm_repo_namespace text NULL);
    CREATE TABLE flux_helm_repo (helm_repo_name text NOT NULL, namespace text NOT NULL, helm_repo_url text NOT NULL,
      interval text NULL, repo_name text NOT NULL, lines number NOT NULL, url text NOT NULL, timestamp text NOT NULL);
    CREATE TABLE flux_oci_repository (name text NOT NULL, tag text NOT NULL, url text NOT NULL, namespace text NULL, repo_name text NOT NULL);
    CREATE TABLE argo_helm_application (release_name text NOT NULL, chart_name text NOT NULL, chart_version text NULL,
      namespace text NULL, repo_name text NOT NULL, hajimari_icon text NULL, hajimari_group text NULL,
      lines number NOT NULL, url text NOT NULL, timestamp text NOT NULL, helm_repo_url text NOT NULL);
  `);

  main
    .prepare(`INSERT INTO repo (repo_name, url, branch, stars) VALUES (?,?,?,?)`)
    .run("onedr0p/home-ops", "https://github.com/onedr0p/home-ops", "main", 2819);
  main
    .prepare(`INSERT INTO repo (repo_name, url, branch, stars) VALUES (?,?,?,?)`)
    .run("carpenike/k8s-gitops", "https://github.com/carpenike/k8s-gitops", "main", 309);
  // Highest-starred repo, deliberately inserted last everywhere (including the
  // values table) so ranking bugs that return rows in table-scan order fail.
  main
    .prepare(`INSERT INTO repo (repo_name, url, branch, stars) VALUES (?,?,?,?)`)
    .run("bigstar/cluster", "https://github.com/bigstar/cluster", "main", 9999);

  // OCI cert-manager in onedr0p (matches the real /hr id).
  main
    .prepare(`INSERT INTO flux_helm_release VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("cert-manager", "cert-manager", "v1.14.0", "cert-manager", "onedr0p/home-ops", null, null,
      "OCIRepository", 20, "https://github.com/onedr0p/home-ops/blob/main/k8s/cert-manager/helmrelease.yaml",
      "2026-06-01T00:00:00Z", "cert-manager", null);
  main
    .prepare(`INSERT INTO flux_oci_repository VALUES (?,?,?,?,?)`)
    .run("cert-manager", "v1.14.0", "oci://ghcr.io/home-operations/charts-mirror/cert-manager", null, "onedr0p/home-ops");

  // chartRef -> OCIRepository: a HelmRelease NAMED "homepage" that actually deploys the
  // bjw-s app-template chart. mergeHelmURL collapses the real url to the generic bjw-s
  // 'charts/' key, and the indexer records chart_name as the release name ("homepage") —
  // so the new raw `sourceUrl`/`resolvedChart` fields must recover the real chart.
  main
    .prepare(`INSERT INTO flux_helm_release VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("homepage", "homepage", "5.0.1", "default", "onedr0p/home-ops", null, null,
      "OCIRepository", 12, "https://github.com/onedr0p/home-ops/blob/main/k8s/homepage/helmrelease.yaml",
      "2026-06-02T00:00:00Z", "homepage", null);
  main
    .prepare(`INSERT INTO flux_oci_repository VALUES (?,?,?,?,?)`)
    .run("homepage", "5.0.1", "oci://ghcr.io/bjw-s-labs/helm/app-template", null, "onedr0p/home-ops");

  // HelmRepository cert-manager (jetstack) in carpenike.
  main
    .prepare(`INSERT INTO flux_helm_release VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("cert-manager", "cert-manager", "v1.13.0", "cert-manager", "carpenike/k8s-gitops", null, null,
      "HelmRepository", 18, "https://github.com/carpenike/k8s-gitops/blob/main/k8s/cert-manager/hr.yaml",
      "2026-05-20T00:00:00Z", "jetstack", "flux-system");
  main
    .prepare(`INSERT INTO flux_helm_repo VALUES (?,?,?,?,?,?,?,?)`)
    .run("jetstack", "flux-system", "https://charts.jetstack.io", "1h", "carpenike/k8s-gitops", 5,
      "https://github.com/carpenike/k8s-gitops/blob/main/k8s/jetstack-repo.yaml", "2026-05-20T00:00:00Z");

  // Same jetstack chart source as carpenike, so this joins that group.
  main
    .prepare(`INSERT INTO flux_helm_release VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("cert-manager", "cert-manager", "v1.14.1", "cert-manager", "bigstar/cluster", null, null,
      "HelmRepository", 22, "https://github.com/bigstar/cluster/blob/main/apps/cert-manager/hr.yaml",
      "2026-06-10T00:00:00Z", "jetstack", "flux-system");
  main
    .prepare(`INSERT INTO flux_helm_repo VALUES (?,?,?,?,?,?,?,?)`)
    .run("jetstack", "flux-system", "https://charts.jetstack.io", "1h", "bigstar/cluster", 5,
      "https://github.com/bigstar/cluster/blob/main/apps/jetstack-repo.yaml", "2026-06-10T00:00:00Z");

  main.close();

  const ext = new Database(extPath);
  ext.exec(`
    CREATE TABLE flux_helm_release_values (url text NOT NULL, val longtext null);
    CREATE TABLE argo_helm_application_values (url text NOT NULL, val longtext null);
  `);
  ext
    .prepare(`INSERT INTO flux_helm_release_values VALUES (?,?)`)
    .run(
      "https://github.com/onedr0p/home-ops/blob/main/k8s/cert-manager/helmrelease.yaml",
      JSON.stringify({
        installCRDs: true,
        image: { repository: "quay.io/jetstack/cert-manager-controller", tag: "v1.14.0" },
        podDnsPolicy: "None",
        ingressShim: { defaultIssuerName: "letsencrypt-production" },
        extraArgs: ["--dns01-recursive-nameservers-only"],
        annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-production" },
      }),
    );
  ext
    .prepare(`INSERT INTO flux_helm_release_values VALUES (?,?)`)
    .run(
      "https://github.com/carpenike/k8s-gitops/blob/main/k8s/cert-manager/hr.yaml",
      JSON.stringify({ installCRDs: true, replicaCount: 1 }),
    );
  // Written last on purpose — see the repo insert above.
  ext
    .prepare(`INSERT INTO flux_helm_release_values VALUES (?,?)`)
    .run(
      "https://github.com/bigstar/cluster/blob/main/apps/cert-manager/hr.yaml",
      JSON.stringify({
        installCRDs: true,
        replicaCount: 3,
        prometheus: { enabled: true },
        image: { repository: "quay.io/jetstack/cert-manager-webhook", tag: "v1.14.1" },
      }),
    );
  ext.close();
}
