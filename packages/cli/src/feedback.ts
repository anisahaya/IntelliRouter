import { controlRequest } from "./http.js";

export function submitFeedback(routeId: string, outcome: string): Promise<unknown> {
  return controlRequest("/router/feedback", {
    method: "POST",
    body: JSON.stringify({ routeId, outcome, tags: [] }),
  });
}
