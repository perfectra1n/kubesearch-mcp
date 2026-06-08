/**
 * Ported VERBATIM (behavior-preserving) from upstream kubesearch.dev:
 *   web/src/generators/helm-release/generator.ts
 *
 * These two functions determine the `/hr/<id>` slug used by kubesearch.dev.
 * They MUST stay behaviorally identical so the links this server produces match
 * the real site. Any change here should be matched by a test vector in
 * test/releaseKey.test.ts.
 */

/**
 * Normalize a Helm repository URL so equivalent chart sources collapse to one
 * canonical URL (e.g. the various bjw-s registries, bitnami, prometheus-community).
 */
export function mergeHelmURL(url: string): string {
  const cleanUrl = url.replace(/\/$/, "");

  // normalize bjw-s / bjw-s-labs repositories
  // - https://bjw-s.github.io/helm-charts
  // - oci://ghcr.io/bjw-s/helm
  // - oci://ghcr.io/bjw-s-labs/app-template
  // - oci://ghcr.io/bjw-s-labs/charts
  if (
    cleanUrl.includes("bjw-s.github.io/helm-charts") ||
    cleanUrl.match(/ghcr\.io\/bjw-s(-labs)?\/(helm|charts|app-template)/)
  ) {
    return "oci://ghcr.io/bjw-s-labs/charts/";
  }

  // Handle standard mappings (wrap http to known oci registries)
  const mapping: Record<string, string> = {
    "https://charts.bitnami.com/bitnami": "oci://registry-1.docker.io/bitnamicharts/",
    "https://github.com/prometheus-community/helm-charts": "oci://ghcr.io/prometheus-community/charts/",
    "https://prometheus-community.github.io/helm-charts": "oci://ghcr.io/prometheus-community/charts/",
    "https://actions.github.io/actions-runner-controller": "oci://ghcr.io/actions/actions-runner-controller-charts/",
    "https://kyverno.github.io/kyverno": "oci://ghcr.io/kyverno/charts/",
    "https://grafana.github.io/helm-charts": "oci://ghcr.io/grafana-operator/helm-charts/",
  };

  if (Object.prototype.hasOwnProperty.call(mapping, cleanUrl)) return mapping[cleanUrl]!;
  if (Object.prototype.hasOwnProperty.call(mapping, url)) return mapping[url]!;

  return url;
}

/**
 * Compute the kubesearch.dev release key (the `/hr/<id>` slug) for a deployment.
 *
 * @param _url        the (already merged) helm repo URL
 * @param chart_name  chart name from the HelmRelease
 * @param release_name HelmRelease metadata.name
 */
export function releaseKey(_url: string, chart_name: string, release_name: string): string {
  const url = _url
    .replace("https://", "")
    .replace("http://", "")
    .replace("oci://", "")
    .replace(/\/$/, "")
    .replaceAll("/", "-");

  let key: string;
  // OCI Repo's tend to have the chart name as the last part of the URL
  if (url.endsWith(chart_name)) {
    // If the chart name is the same as the release name, use the URL without the release name
    if (chart_name === release_name) {
      key = url;
    } else {
      key = url + "-" + release_name;
    }
  }
  // helm repo case
  else {
    // when the chart name is the same as the release name, use the URL without the release name
    if (chart_name === release_name) {
      key = url + "-" + chart_name;
    } else {
      key = url + "-" + `${chart_name}-${release_name}`;
    }
  }

  return key
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^a-zA-Z0-9\.\-]/gi, "")
    .replaceAll(/^\.+/g, "")
    .toLowerCase();
}
