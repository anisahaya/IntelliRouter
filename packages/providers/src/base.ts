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
