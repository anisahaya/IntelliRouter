import { controlRequest } from "./http.js";

export function routeTask(task: string, profile: string): Promise<unknown> {
  return controlRequest("/router/route", {
    method: "POST",
    body: JSON.stringify({ task, profile }),
  });
}
