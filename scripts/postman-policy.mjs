const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isAllowedPostmanUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (raw.startsWith("{{baseUrl}}")) {
    const path = raw.slice("{{baseUrl}}".length);
    return /^\/(?:[^{}]|\{\{routeId\}\})+$/.test(path);
  }
  if (/\{\{[^}]+\}\}/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      LOOPBACK_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function collectPostmanOffenders(collection) {
  if (!collection || typeof collection !== "object" || !Array.isArray(collection.item))
    throw new Error("Postman collection must contain an item array");
  const offenders = [];
  scanScripts(collection.event ?? [], "<collection>");
  const visit = (items, path = []) => {
    if (!Array.isArray(items)) throw new Error("Postman item must be an array");
    for (const item of items) {
      if (!item || typeof item !== "object") {
        offenders.push({ name: path.join("/") || "<unknown>", reason: "malformed item" });
        continue;
      }
      const name = [...path, item.name ?? "<unnamed>"].join("/");
      if (Array.isArray(item.item)) visit(item.item, [...path, item.name ?? "<folder>"]);
      const url = item.request?.url;
      const raw = typeof url === "object" ? url?.raw : url;
      if (url !== undefined && !isAllowedPostmanUrl(raw))
        offenders.push({ name, url: raw, reason: "non-loopback or unresolved URL" });
      scanScripts(item, name);
    }
  };
  visit(collection.item);
  function scanScripts(value, name) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) scanScripts(child, name);
      return;
    }
    if (value.script?.exec !== undefined) {
      const exec = value.script.exec;
      const source = Array.isArray(exec) ? exec.join("\n") : typeof exec === "string" ? exec : "";
      if (
        /\b(?:pm\.sendRequest|(?:globalThis\.)?fetch|axios\.(?:request|get|post|put|patch|delete)|https?\.request|new\s+XMLHttpRequest)\s*\(/.test(
          source,
        )
      ) {
        offenders.push({ name, reason: "dynamic outbound script API" });
      }
    }
    for (const [key, child] of Object.entries(value))
      if (key !== "request") scanScripts(child, name);
  }
  return offenders;
}

// Static sanity checking only; this is not a sandbox.
