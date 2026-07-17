const secretPatterns: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\b(?:sk|ghp|github_pat|xox[abprs])-[-A-Za-z0-9_]{12,}\b/g, "[REDACTED_TOKEN]"],
  [/\bBearer\s+[-._~+/A-Za-z0-9]+=*\b/gi, "Bearer [REDACTED]"],
  [
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
    "$1=[REDACTED]",
  ],
  [
    /(["'](?:token|secret|password|credential|api[_-]?key|authorization)["']\s*:\s*["'])[^"']+(["'])/gi,
    "$1[REDACTED]$2",
  ],
];

export interface SanitizedText {
  text: string;
  truncated: boolean;
  redacted: boolean;
}

export function sanitizeText(value: string, maxChars: number, label: string): SanitizedText {
  if (value.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  let text = value;
  let redacted = false;
  for (const [pattern, replacement] of secretPatterns) {
    const next = text.replace(pattern, replacement);
    if (next !== text) redacted = true;
    text = next;
  }
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { text, truncated, redacted };
}

export function sanitizeAcceptanceChecks(values: string[] | undefined): SanitizedText[] {
  return (values ?? [])
    .slice(0, 16)
    .map((value, index) => sanitizeText(value, 500, `acceptanceChecks[${index}]`));
}

export function boundedOutput(value: string, maxChars: number): SanitizedText {
  return sanitizeText(value, maxChars, "child output");
}

export function assertRootInvocation(env: NodeJS.ProcessEnv = process.env): void {
  const depth = Number.parseInt(env.MODEL_ROUTER_CHILD_DEPTH ?? "0", 10);
  if (Number.isFinite(depth) && depth >= 1) {
    throw new Error("auto routing is disabled inside a routed child task");
  }
}
