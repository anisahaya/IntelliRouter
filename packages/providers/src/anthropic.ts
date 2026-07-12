import type { ModelDefinition, NormalizedRequest, Protocol } from "@model-router/contracts";
import type { ErrorClass } from "@model-router/router-core";
import type { PreparedProviderRequest, ProviderAdapter } from "./base.js";
import { joinUrl } from "./streaming.js";

export class AnthropicAdapter implements ProviderAdapter {
  supports(protocol: Protocol): boolean {
    return protocol === "anthropic-messages";
  }

  prepareRequest(
    model: ModelDefinition,
    request: NormalizedRequest,
    apiKey: string,
  ): PreparedProviderRequest {
    return {
      url: joinUrl(model.baseUrl, "/v1/messages"),
      init: {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request.passThroughBody, model: model.upstreamModel }),
      },
    };
  }

  send(prepared: PreparedProviderRequest, signal?: AbortSignal): Promise<Response> {
    return fetch(prepared.url, { ...prepared.init, signal });
  }

  stream(response: Response): ReadableStream<Uint8Array> | null {
    return response.body;
  }

  classifyError(error: unknown, response?: Response): ErrorClass {
    if (error instanceof DOMException && error.name === "AbortError") return "timeout";
    if (!response) return "unknown";
    if (response.status === 429) return "rate_limit";
    if (response.status === 529) return "overloaded";
    if (response.status >= 500) return "upstream_5xx";
    if (response.status >= 400) return "client";
    return "unknown";
  }
}
