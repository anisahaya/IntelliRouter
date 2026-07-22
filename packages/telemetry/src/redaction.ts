const sensitive = /(?:token|secret|password|key|credential|authorization|cookie)/i;
export const TOKEN_LITERAL =
  /\b(?:sk|ghp|github_pat|xox[abprs]|key-|bearer)[-._~+/A-Za-z0-9]{8,}\b/i;
const TOKEN_TEXT_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:sk|ghp|github_pat|xox[abprs]|key-)[-._~+/A-Za-z0-9]{8,}\b/gi,
  /\b(?:token|api[-_]?key|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
];
const MAX_DEPTH = 32;

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return redactValue(headers) as Record<string, unknown>;
}

export function redactTokenText(value: string): string {
  return TOKEN_TEXT_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, (match) =>
        /^Bearer\s/i.test(match) ? "Bearer [REDACTED]" : "[REDACTED]",
      ),
    value,
  );
}

export class BoundedParseError extends Error {
  constructor(reason: "too_long" | "too_deep" | "invalid_json", message: string) {
    super(`BoundedParseError:${reason}: ${message}`);
    this.name = "BoundedParseError";
  }
}

export function parseBoundedJSON(source: string, maxLen: number, maxDepth = MAX_DEPTH): unknown {
  if (typeof source !== "string") throw new BoundedParseError("invalid_json", "non-string input");
  if (source.length > maxLen) {
    throw new BoundedParseError("too_long", `input ${source.length}B exceeds ${maxLen}B`);
  }
  const parsed: unknown = JSON.parse(source);
  if (depthOf(parsed, 0, maxDepth) > maxDepth) {
    throw new BoundedParseError("too_deep", `nesting exceeds ${maxDepth}`);
  }
  return parsed;
}

function depthOf(value: unknown, current: number, limit: number): number {
  if (current > limit) return current + 1;
  if (Array.isArray(value)) {
    let max = current;
    for (const item of value) {
      const d = depthOf(item, current + 1, limit);
      if (d > max) max = d;
      if (max > limit) return max;
    }
    return max;
  }
  if (value && typeof value === "object") {
    let max = current;
    for (const item of Object.values(value as Record<string, unknown>)) {
      const d = depthOf(item, current + 1, limit);
      if (d > max) max = d;
      if (max > limit) return max;
    }
    return max;
  }
  return current;
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
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()])
        if (sensitive.test(key)) url.searchParams.set(key, "[REDACTED]");
      return url.toString();
    } catch {
      return redactTokenText(value);
    }
  }
  return value;
}
