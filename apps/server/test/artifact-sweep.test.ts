import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactService } from "../src/services/artifacts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "artsweep-"));
  const rows = { projects: [] as unknown[], sessions: [] as unknown[] };
  // Minimal stand-in: the sweep only does select().from(t)[.where()].all()
  const db = {
    select: () => ({
      from: (t: unknown) => {
        const name = (t as Record<symbol, string>)[Symbol.for("drizzle:Name")];
        const data = name === "projects" ? rows.projects : rows.sessions;
        const q = { where: () => q, all: () => data };
        return q;
      },
    }),
  };
  return { dir, rows, svc: new ArtifactService(db as never, {} as never, dir) };
}

describe("ArtifactService.sweep", () => {
  it("removes old .incoming files and files of long-archived sessions only", () => {
    const { dir, rows, svc } = setup();
    mkdirSync(join(dir, ".incoming"), { recursive: true });
    const oldTmp = join(dir, ".incoming", "old.png");
    const newTmp = join(dir, ".incoming", "new.png");
    writeFileSync(oldTmp, "x");
    writeFileSync(newTmp, "x");
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(oldTmp, longAgo, longAgo);
    for (const id of ["old-s", "recent-s", "live-s"]) {
      mkdirSync(join(dir, id));
      writeFileSync(join(dir, id, "a.png"), "x");
    }
    const day = 24 * 3600_000;
    rows.sessions = [
      { id: "old-s", at: new Date(Date.now() - 40 * day).toISOString(), projectId: null },
      { id: "recent-s", at: new Date(Date.now() - 2 * day).toISOString(), projectId: null },
      { id: "live-s", at: null, projectId: null },
    ];
    expect(svc.sweep()).toEqual({ incoming: 1, archived: 1 });
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(newTmp)).toBe(true);
    expect(existsSync(join(dir, "old-s"))).toBe(false);
    expect(existsSync(join(dir, "recent-s", "a.png"))).toBe(true);
    expect(existsSync(join(dir, "live-s", "a.png"))).toBe(true);
  });
});
