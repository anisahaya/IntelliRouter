import { controlRequest } from "./http.js";

export function getStats(since?: string): Promise<unknown> {
  const normalized = since ? normalizeSince(since) : undefined;
  const query = normalized ? `?since=${encodeURIComponent(normalized)}` : "";
  return controlRequest(`/router/stats${query}`);
}

function normalizeSince(value: string): string {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return value;
  const amount = Number(match[1]);
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return new Date(Date.now() - amount * units[match[2] as keyof typeof units]).toISOString();
}
