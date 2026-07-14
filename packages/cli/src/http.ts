function baseUrl(): string {
  return (process.env.MODEL_ROUTER_BASE_URL ?? "http://127.0.0.1:8856").replace(/\/$/, "");
}

export async function controlRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (process.env.MODEL_ROUTER_AUTH_TOKEN)
    headers.set("authorization", `Bearer ${process.env.MODEL_ROUTER_AUTH_TOKEN}`);
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 4_096) };
  }
  if (!response.ok) throw new Error(`router returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
