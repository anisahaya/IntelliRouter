import { readFileSync } from "node:fs";

const policy = JSON.parse(
  readFileSync(new URL("../security/audit-policy.json", import.meta.url), "utf8"),
);
const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
});
const report = JSON.parse(input);
const allowed = new Set(
  (policy.allowModerate ?? []).map(
    (entry) => `${entry.advisory}|${entry.package}|${entry.version}`,
  ),
);
const failures = [];
for (const advisory of Object.values(report.advisories ?? {})) {
  for (const finding of advisory.findings ?? []) {
    if (!["moderate", "high", "critical"].includes(advisory.severity)) continue;
    const key = `${advisory.github_advisory_id}|${advisory.module_name}|${finding.version}`;
    if (advisory.severity === "moderate" && allowed.has(key)) continue;
    failures.push(`${advisory.severity}: ${key}`);
  }
}
if (failures.length) {
  console.error(`audit policy failed:\n${failures.join("\n")}`);
  process.exit(1);
}
