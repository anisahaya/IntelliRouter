const sensitive = /(?:token|secret|password|key|credential|authorization|cookie)/i;

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return redactValue(headers) as Record<string, unknown>;
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitive.test(key) ? "[REDACTED]" : redactValue(item),
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
      return value;
    }
  }
  return value;
}
