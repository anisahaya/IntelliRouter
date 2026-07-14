export type ErrorClass =
  | "timeout"
  | "network"
  | "rate_limit"
  | "overloaded"
  | "upstream_5xx"
  | "auth"
  | "model_not_found"
  | "client"
  | "unknown";

export function canFallback(
  errorClass: ErrorClass,
  configured: string[],
  bytesEmitted: boolean,
): boolean {
  return !bytesEmitted && configured.includes(errorClass);
}
