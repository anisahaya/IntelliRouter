const sensitive = /(?:token|secret|password|key|credential|authorization|cookie)/i;
const TOKEN_LITERAL = /\b(?:sk|ghp|github_pat|xox[abprs]|key-|bearer)[-._~+/A-Za-z0-9]{8,}\b/i;
const MAX_DEPTH = 32;

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return redactValue(headers) as Record<string, unknown>;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[REDACTED_DEPTH_LIMIT]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitive.test(key) ? "[REDACTED]" : redactValue(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "string") {
    if (TOKEN_LITERAL.test(value)) return "[REDACTED]";
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()])
        if (sensitive.test(key)) url.searchParams.set(key, "[REDACTED]");
      return url.toString();
    } catch {
      return value;
    }
  }
  return value;
}
