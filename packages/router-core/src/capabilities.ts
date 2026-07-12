import type { ModelDefinition, NormalizedRequest } from "@model-router/contracts";

export function capabilityExclusions(
  model: ModelDefinition,
  request: NormalizedRequest,
  healthy = true,
): string[] {
  const reasons: string[] = [];
  if (!model.enabled) reasons.push("model is disabled");
  if (!healthy) reasons.push("model is unhealthy");
  if (!model.capabilities.protocols.includes(request.protocol))
    reasons.push(`protocol ${request.protocol} is unsupported`);
  if (request.toolsRequired && !model.capabilities.tools) reasons.push("tool use is unsupported");
  if (request.jsonRequired && !model.capabilities.json)
    reasons.push("structured JSON is unsupported");
  if (request.visionRequired && !model.capabilities.vision) reasons.push("vision is unsupported");
  if (request.stream && !model.capabilities.streaming) reasons.push("streaming is unsupported");
  if (request.minimumContextTokens > model.capabilities.maxContextTokens)
    reasons.push("context window is too small");
  return reasons;
}
