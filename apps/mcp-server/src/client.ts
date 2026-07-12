export interface ProxyClientOptions {
  baseUrl?: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export class ProxyClient {
  readonly baseUrl: string;
  readonly authToken?: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: ProxyClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.MODEL_ROUTER_BASE_URL ??
      "http://127.0.0.1:8856"
    ).replace(/\/$/, "");
    this.authToken = options.authToken ?? process.env.MODEL_ROUTER_AUTH_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  routeTask(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/router/route", { method: "POST", body: JSON.stringify(input) });
  }

  explainRoute(routeId: string): Promise<Record<string, unknown>> {
    return this.request(`/router/routes/${encodeURIComponent(routeId)}`);
  }

  stats(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.request(`/router/stats${suffix}`);
  }

  feedback(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/router/feedback", { method: "POST", body: JSON.stringify(input) });
  }

  models(): Promise<Record<string, unknown>> {
    return this.request("/router/models");
  }

  async delegate(input: {
    prompt: string;
    profile?: string;
    model?: string;
    session?: string;
    maxOutputTokens: number;
  }): Promise<Record<string, unknown>> {
    const selected = input.model ?? (input.profile ? `router/${input.profile}` : "auto");
    const response = await this.raw("/v1/chat/completions", {
      method: "POST",
      headers: input.session ? { "x-router-session": input.session } : undefined,
      body: JSON.stringify({
        model: selected,
        stream: false,
        max_tokens: input.maxOutputTokens,
        messages: [{ role: "user", content: input.prompt }],
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    const choices = body.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const text = String(message?.content ?? "").slice(0, 32_000);
    return {
      text,
      model: response.headers.get("x-router-model") ?? String(body.model ?? "unknown"),
      requestId: response.headers.get("x-router-request-id") ?? "unknown",
      routeId: response.headers.get("x-router-route-id") ?? "unknown",
      fallbackCount: Number(response.headers.get("x-router-fallback-count") ?? 0),
      usage: body.usage ?? {},
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.raw(path, init);
    const value = (await response.json()) as Record<string, unknown>;
    return boundObject(value);
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.authToken) headers.set("authorization", `Bearer ${this.authToken}`);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 4_096);
      throw new Error(`router ${path} returned ${response.status}: ${message}`);
    }
    return response;
  }
}

function boundObject(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (encoded.length <= 64_000) return value;
  return { truncated: true, preview: encoded.slice(0, 63_000) };
}
