import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function resolveTrustedWorkspace(
  requested: string,
  trustedRoot = process.env.MODEL_ROUTER_WORKSPACE_ROOT ?? process.cwd(),
): Promise<string> {
  const [workspace, trusted] = await Promise.all([realpath(requested), realpath(trustedRoot)]);
  if (!isWithin(workspace, trusted)) {
    throw new Error("workspace root is outside the model router's trusted root");
  }
  return workspace;
}

export async function resolveTrustedFile(path: string, allowedRoots: string[]): Promise<string> {
  const file = await realpath(path);
  if (!(await stat(file)).isFile()) throw new Error("image path must be a file");
  const settled = await Promise.allSettled(allowedRoots.map((root) => realpath(resolve(root))));
  const roots = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (!roots.some((root) => isWithin(file, root))) {
    throw new Error("image path is outside the model router's trusted roots");
  }
  return file;
}

function isWithin(value: string, root: string): boolean {
  const path = relative(root, value);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
