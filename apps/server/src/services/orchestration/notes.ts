import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "@codeden/contracts";
import { ServiceError } from "../errors";
import type { ProjectService } from "../projects/project-service";
import { addDecisions, type DecisionAdds } from "./decisions";

/** Relative path of a project's PM notes. */
export const NOTES_PATH = ".codeden/notes.md";
const MAX_BYTES = 200_000;

/** A project's notes read from its folder; "" when there are none. */
export function readNotesFile(project: Pick<Project, "path">): string {
  const file = join(project.path, NOTES_PATH);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * The PM's durable notes for a project, in the repo's `.codeden/notes.md` next to the other
 * project files (`project.json`, `VISION.md`), so they stay readable and editable. Written by
 * the server on the PM's behalf: the PM itself has no write access to the repo.
 */
export class ProjectNotes {
  constructor(private readonly projects: ProjectService) {}

  path(projectId: string): string {
    return join(this.projects.get(projectId).path, NOTES_PATH);
  }

  read(projectId: string): string {
    const file = this.path(projectId);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  /**
   * Record decisions and turned-down ideas, each with its reason, in the notes' Decisions section
   * (made when missing). The rest of the notes stays as it is; an item already listed isn't repeated.
   */
  recordDecisions(projectId: string, adds: DecisionAdds): { decided: number; turnedDown: number } {
    const result = addDecisions(this.read(projectId), adds);
    if (result.decided + result.turnedDown > 0) this.write(projectId, result.text, "replace");
    return { decided: result.decided, turnedDown: result.turnedDown };
  }

  /** Replace the notes or append a section; returns the new content. */
  write(projectId: string, content: string, mode: "replace" | "append"): string {
    const current = mode === "append" ? this.read(projectId) : "";
    const next =
      mode === "append" && current.trim()
        ? `${current.replace(/\s*$/, "")}\n\n${content.trim()}\n`
        : `${content.trim()}\n`;
    if (Buffer.byteLength(next, "utf8") > MAX_BYTES) {
      throw new ServiceError(413, "notes_too_large", "Project notes are limited to 200 KB");
    }
    const file = this.path(projectId);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, file);
    return next;
  }
}
