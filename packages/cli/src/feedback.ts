import { controlRequest } from "./http.js";

export function submitFeedback(
  routeId: string,
  outcome: string,
  score?: number,
  tags: string[] = [],
): Promise<unknown> {
  return controlRequest("/router/feedback", {
    method: "POST",
    body: JSON.stringify({ routeId, outcome, score, tags }),
  });
}
