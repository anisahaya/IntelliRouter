import { controlRequest } from "./http.js";

export function explainRoute(id: string): Promise<unknown> {
  return controlRequest(`/router/routes/${encodeURIComponent(id)}`);
}
