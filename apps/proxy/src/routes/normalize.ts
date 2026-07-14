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

function contentBlocks(protocol: Protocol, body: Record<string, unknown>): unknown[] {
  const source = protocol === "openai-responses" ? body.input : body.messages;
  if (!Array.isArray(source)) return [];
  const blocks: unknown[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (Array.isArray(content)) blocks.push(...content);
    else if (content && typeof content === "object") blocks.push(content);
  }
  return blocks;
}

function requiresVision(protocol: Protocol, body: Record<string, unknown>): boolean {
  const validTypes =
    protocol === "openai-chat"
      ? new Set(["image_url"])
      : protocol === "openai-responses"
        ? new Set(["input_image"])
        : new Set(["image"]);
  return contentBlocks(protocol, body).some((block) => {
    if (!block || typeof block !== "object") return false;
    return validTypes.has(String((block as Record<string, unknown>).type));
  });
}

export function normalizeRequest(
  protocol: Protocol,
  body: Record<string, unknown>,
): NormalizedRequest {
  for (const field of ["max_completion_tokens", "max_tokens", "max_output_tokens"] as const) {
    const value = body[field];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }
  const source = protocol === "openai-responses" ? body.input : body.messages;
  const contextText = [body.instructions, body.system, source, body.tools].map(textFrom).join(" ");
  const summary = contextText.slice(0, 8_000);
  const toolsRequired = Array.isArray(body.tools) && body.tools.length > 0;
  const format =
    protocol === "openai-chat"
      ? (body.response_format as Record<string, unknown> | undefined)
      : protocol === "openai-responses"
        ? ((body.text as Record<string, unknown> | undefined)?.format as
            | Record<string, unknown>
            | undefined)
        : ((body.output_config as Record<string, unknown> | undefined)?.format as
            | Record<string, unknown>
            | undefined);
  const jsonRequired = Boolean(
    format && ["json_object", "json_schema"].includes(String(format.type)),
  );
  const visionRequired = requiresVision(protocol, body);
  const estimatedInputTokens = Math.ceil(contextText.length / 4);
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
      estimatedInputTokens +
      Number(body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? 0),
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
