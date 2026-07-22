import { lookup } from "node:dns/promises";
import type { ModelDefinition, NormalizedRequest, Protocol } from "@model-router/contracts";
import type { ErrorClass } from "@model-router/router-core";

export interface PreparedProviderRequest {
  url: string;
  init: RequestInit;
}

export interface ProviderAdapter {
  supports(protocol: Protocol): boolean;
  prepareRequest(
    model: ModelDefinition,
    request: NormalizedRequest,
    apiKey: string,
  ): PreparedProviderRequest;
  send(prepared: PreparedProviderRequest, signal?: AbortSignal): Promise<Response>;
  stream(response: Response): ReadableStream<Uint8Array> | null;
  classifyError(error: unknown, response?: Response): ErrorClass;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function isLinkLocal(hostname: string): boolean {
  return (
    hostname.startsWith("169.254.") ||
    hostname.startsWith("fe80:") ||
    hostname === "0.0.0.0" ||
    hostname === "[::]"
  );
}

function isPrivateRfc1918(hostname: string): boolean {
  return (
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
  );
}

export async function assertSafeEgress(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpstreamError("upstream URL is invalid", 400);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UpstreamError("upstream URL must use http(s)", 400);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback = loopbackHosts.has(hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new UpstreamError("http:// upstream is only permitted on loopback", 400);
  }
  if (isLinkLocal(hostname) || isPrivateRfc1918(hostname) || isPrivateIpv6(hostname)) {
    if (loopback) return;
    throw new UpstreamError("upstream host is in a link-local or private range", 400);
  }
  if (!loopback) {
    // Resolve all answers at request time; DNS can still rebind after this check,
    // so deployments should additionally enforce outbound network policy.
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new UpstreamError("upstream host could not be resolved", 400);
    }
    if (!addresses.length || addresses.some((entry) => !isGlobalAddress(entry.address))) {
      throw new UpstreamError("upstream host resolves to a private or non-global address", 400);
    }
  }
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:")
  );
}

function isGlobalAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateRfc1918(host) || isLinkLocal(host) || isPrivateIpv6(host)) return false;
  if (/^127\./.test(host) || host === "0.0.0.0") return false;
  return true;
}
