import net from "node:net";
import type { CloneConfig } from "../config.js";

export interface ResolvedTarget {
  /** The exact https URL that will be handed to `git clone`. */
  url: string;
  /** Hostname (lowercased). */
  host: string;
}

export class CloneValidationError extends Error {}

/**
 * Validate a user-supplied clone target. Defends against:
 *  - non-https schemes (ssh/file/git/http) — only https is allowed,
 *  - argument injection (leading "-"),
 *  - embedded credentials (userinfo),
 *  - SSRF to private/loopback/link-local/metadata addresses,
 *  - hosts outside an optional allowlist.
 */
export function validateCloneUrl(raw: string, cfg: CloneConfig): ResolvedTarget {
  const input = raw.trim();
  if (input === "" || input.startsWith("-")) {
    throw new CloneValidationError(`Invalid repository URL: ${JSON.stringify(raw)}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new CloneValidationError(`Not a valid URL: ${JSON.stringify(raw)} (expected an https:// git URL)`);
  }

  if (parsed.protocol !== "https:") {
    throw new CloneValidationError(`Only https:// clone URLs are allowed (got "${parsed.protocol}//").`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CloneValidationError("Clone URLs must not contain embedded credentials.");
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "") throw new CloneValidationError("Clone URL has no host.");

  if (cfg.allowedHosts.length > 0 && !cfg.allowedHosts.includes(host)) {
    throw new CloneValidationError(`Host "${host}" is not in the allowed hosts list (${cfg.allowedHosts.join(", ")}).`);
  }

  if (!cfg.allowPrivate && isPrivateHost(host)) {
    throw new CloneValidationError(
      `Refusing to clone from private/loopback/metadata address "${host}" (set KUBESEARCH_CLONE_ALLOW_PRIVATE=true to override).`,
    );
  }

  // Rebuild a clean URL (origin + pathname) to drop any fragment/auth oddities.
  const clean = `https://${parsed.host}${parsed.pathname}${parsed.search}`;
  return { url: clean, host };
}

/** Heuristic SSRF guard for hostnames and IP literals. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;

  const ipVersion = net.isIP(h);
  if (ipVersion === 4) return isPrivateIPv4(h);
  if (ipVersion === 6) return isPrivateIPv6(h);

  // Not an IP literal and not an obviously-internal suffix: treat as public.
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local fc00::/7
  if (h.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && mapped[1]) return isPrivateIPv4(mapped[1]);
  return false;
}
