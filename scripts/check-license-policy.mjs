const permissive =
  /^(?:MIT|Apache-2\.0|BSD(?:-\d-Clause)?|ISC|0BSD|CC0-1\.0|Unlicense|Zlib|Python-2\.0|BlueOak-1\.0\.0)$/;
const copyleft =
  /(?:^|[- ]|\()A?GPL(?:[- ]?\d(?:\.\d)?|\+)?(?:\)|$)|(?:^|[- ])AGPL(?:[- ]?\d(?:\.\d)?|\+)?(?:\)|$)/i;
const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    data += c;
  });
  process.stdin.on("end", () => resolve(data));
});
const groups = JSON.parse(input);
const failures = [];
for (const [expression, packages] of Object.entries(groups)) {
  if (!copyleft.test(expression)) continue;
  const alternatives = expression
    .split(/\s+OR\s+/i)
    .map((part) => part.replace(/[()]/g, "").trim());
  if (alternatives.some((part) => permissive.test(part))) continue;
  for (const pkg of packages)
    failures.push(`${pkg.name}@${pkg.versions?.join(",")}: ${expression}`);
}
if (failures.length) {
  console.error(`license policy failed:\n${failures.join("\n")}`);
  process.exit(1);
}
