import type { NormalizedRequest, TaskFeatures } from "@model-router/contracts";

export function extractFeatures(request: NormalizedRequest): TaskFeatures {
  const text = request.summary.toLowerCase();
  const hasCode = /```|\b(function|class|const|let|def|import|package|error|stack trace)\b/.test(
    text,
  );
  const taskType = /debug|error|fix|failing|stack trace/.test(text)
    ? "debug"
    : /review|audit|critique/.test(text)
      ? "review"
      : /research|compare|investigate/.test(text)
        ? "research"
        : hasCode
          ? "code"
          : "general";
  const agentic = request.toolsRequired || /implement|edit|run|test|repository|codebase/.test(text);
  const reasoningIntensity = /deep|complex|architect|reason|hard/.test(text)
    ? "high"
    : /simple|quick|tiny|format/.test(text)
      ? "low"
      : "medium";
  return {
    taskType,
    hasCode,
    agentic,
    reasoningIntensity,
    estimatedInputTokens: request.estimatedInputTokens,
  };
}
