import { controlRequest } from "./http.js";

export function routeTask(
  task: string,
  profile: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  return controlRequest("/router/route", {
    method: "POST",
    body: JSON.stringify({ task, profile, ...options }),
  });
}
