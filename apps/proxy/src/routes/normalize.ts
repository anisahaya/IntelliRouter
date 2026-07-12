import type { NormalizedRequest, Protocol } from "@model-router/contracts";

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (record.content) return textFrom(record.content);
    return Object.values(record).map(textFrom).join(" ");
  }
  return "";
}

export function normalizeRequest(
  protocol: Protocol,
  body: Record<string, unknown>,
): NormalizedRequest {
  const source = protocol === "openai-responses" ? body.input : body.messages;
  const summary = textFrom(source).slice(0, 8_000);
  const toolsRequired = Array.isArray(body.tools) && body.tools.length > 0;
  const responseFormat = body.response_format as Record<string, unknown> | undefined;
  const jsonRequired = Boolean(
    responseFormat && ["json_object", "json_schema"].includes(String(responseFormat.type)),
  );
  const visionRequired = /image_(?:url|input)|data:image/i.test(JSON.stringify(source ?? ""));
  const estimatedInputTokens = Math.ceil(summary.length / 4);
  const stream = body.stream === true;
  const model = typeof body.model === "string" ? body.model : "auto";
  const requestedProfile = model.startsWith("router/") ? model.slice("router/".length) : undefined;
  const pinnedModel = model !== "auto" && !model.startsWith("router/") ? model : undefined;
  const base = {
    stream,
    summary,
    toolsRequired,
    jsonRequired,
    visionRequired,
    estimatedInputTokens,
    minimumContextTokens:
      estimatedInputTokens + Number(body.max_tokens ?? body.max_output_tokens ?? 0),
    pinnedModel,
    requestedProfile,
    passThroughBody: structuredClone(body),
  };
  if (protocol === "openai-responses") {
    return {
      ...base,
      protocol,
      metadata: {
        inputKind:
          typeof body.input === "string"
            ? "string"
            : Array.isArray(body.input)
              ? "array"
              : "unknown",
      },
    };
  }
  return {
    ...base,
    protocol,
    metadata: { messageCount: Array.isArray(body.messages) ? body.messages.length : 0 },
  };
}
