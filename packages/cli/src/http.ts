function baseUrl(): string {
  return process.env.MODEL_ROUTER_BASE_URL ?? "http://127.0.0.1:8856";
}

export async function controlRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (process.env.MODEL_ROUTER_AUTH_TOKEN)
    headers.set("authorization", `Bearer ${process.env.MODEL_ROUTER_AUTH_TOKEN}`);
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
