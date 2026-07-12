import type { ModelDefinition } from "@model-router/contracts";
import { AnthropicAdapter } from "./anthropic.js";
import type { ProviderAdapter } from "./base.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";

const openai = new OpenAICompatibleAdapter();
const anthropic = new AnthropicAdapter();

export function adapterFor(model: ModelDefinition): ProviderAdapter {
  return model.provider === "anthropic" ? anthropic : openai;
}
