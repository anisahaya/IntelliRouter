import { access, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstalledAssets {
  mcp: string;
  skillDirectory: string;
}

export async function installedAssets(): Promise<InstalledAssets> {
  for (const relativeRoot of ["../../", "../../../"]) {
    const packageRoot = fileURLToPath(new URL(relativeRoot, import.meta.url));
    const mcp = join(packageRoot, "dist", "mcp-server", "index.js");
    const skillDirectory = join(packageRoot, "skills");
    try {
      await Promise.all([
        access(mcp),
        access(join(skillDirectory, "intelligent-model-router", "SKILL.md")),
      ]);
      return { mcp, skillDirectory };
    } catch {
      // Try the source-tree layout after the bundled package layout.
    }
  }
  throw new Error("Runnable assets are missing; run pnpm build or install the packaged release");
}

export async function ensureSkill(
  source: string,
  target: string,
  force: boolean,
  preservedMessage: string,
): Promise<Record<string, unknown>> {
  await mkdir(dirname(target), { recursive: true });
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const current = await readlink(target);
      if (current === source) return { configured: true, changed: false, path: target };
      if (force) {
        await unlink(target);
        await symlink(source, target, "junction");
        return { configured: true, changed: true, path: target };
      }
    }
    return {
      configured: true,
      changed: false,
      path: target,
      message: `An existing skill was preserved; ${preservedMessage}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(source, target, "junction");
  return { configured: true, changed: true, path: target };
}
