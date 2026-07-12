export type ErrorClass =
  | "timeout"
  | "rate_limit"
  | "overloaded"
  | "upstream_5xx"
  | "client"
  | "unknown";

export function canFallback(
  errorClass: ErrorClass,
  configured: string[],
  bytesEmitted: boolean,
): boolean {
  return !bytesEmitted && configured.includes(errorClass);
}
