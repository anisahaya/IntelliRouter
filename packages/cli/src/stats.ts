import { controlRequest } from "./http.js";

export function getStats(since?: string, model?: string, task?: string): Promise<unknown> {
  const normalized = since ? normalizeSince(since) : undefined;
  const params = new URLSearchParams();
  if (normalized) params.set("since", normalized);
  if (model) params.set("model", model);
  if (task) params.set("task", task);
  const query = params.size ? `?${params}` : "";
  return controlRequest(`/router/stats${query}`);
}

function normalizeSince(value: string): string {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return value;
  const amount = Number(match[1]);
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return new Date(Date.now() - amount * units[match[2] as keyof typeof units]).toISOString();
}
