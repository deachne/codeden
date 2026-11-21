import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectConfigFile } from "@codeden/contracts";
import type { Exec } from "../exec";

/** Parse raw JSON text into a ProjectConfigFile, or null when invalid. */
export function parseProjectConfig(raw: string): ProjectConfigFile | null {
  try {
    const parsed = ProjectConfigFile.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The repository's `.codeden/project.json` (§9) read from a git commit or ref, or null when missing
 * or invalid.
 */
export async function readProjectConfigFromGit(
  exec: Exec,
  projectPath: string,
  ref: string,
): Promise<ProjectConfigFile | null> {
  try {
    const result = await exec("git", ["-C", projectPath, "show", `${ref}:.codeden/project.json`], {
      timeoutMs: 10_000,
    });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    return parseProjectConfig(result.stdout);
  } catch {
    return null;
  }
}

/**
 * The repository's `.codeden/project.json` (§9) read from the project root, or null when it is
 * missing or invalid. Small and read on demand (new sessions), so edits apply right away.
 */
export function readProjectConfig(projectPath: string): ProjectConfigFile | null {
  const file = join(projectPath, ".codeden", "project.json");
  if (!existsSync(file)) return null;
  try {
    return parseProjectConfig(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The provider new sessions in a project default to: the project's own setting, else the
 * repository's `.codeden/project.json` `defaultProvider`, else null (role default / auto).
 */
export function projectDefaultProvider(project: {
  defaultProvider: string | null;
  path: string;
}): string | null {
  return project.defaultProvider ?? readProjectConfig(project.path)?.defaultProvider ?? null;
}
