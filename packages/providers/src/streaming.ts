export function responseRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
