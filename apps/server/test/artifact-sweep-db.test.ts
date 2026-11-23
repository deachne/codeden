import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { projects, sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { ArtifactService } from "../src/services/artifacts";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let dir: string;
let database: Database;
let store: EventStore;
let svc: ArtifactService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-artsweep-db-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  svc = new ArtifactService(database.db, store, join(dir, "artifacts"));
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

function addSession(id: string, archivedAt: string | null, projectId: string | null = null) {
  store.append([
    { type: "session.created", sessionId: id, payload: { session: { ...sampleSession, id } } },
  ]);
  database.db.update(sessions).set({ archivedAt, projectId }).where(eq(sessions.id, id)).run();
  const folder = join(dir, "artifacts", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.png"), "x");
  return folder;
}

function addProject(id: string, archivedAt: string | null) {
  database.db
    .insert(projects)
    .values({
      id,
      kind: "local",
      name: id,
      slug: id,
      path: `/tmp/${id}`,
      createdAt: ago(100),
      updatedAt: ago(100),
      archivedAt,
    })
    .run();
}

describe("ArtifactService.sweep with the real database", () => {
  it("applies the retention window to archived sessions and projects", () => {
    addProject("p-old", ago(45));
    addProject("p-new", ago(3));
    const folders = {
      old: addSession("old", ago(45)),
      recent: addSession("recent", ago(3)),
      live: addSession("live", null),
      underOldProject: addSession("in-old-project", null, "p-old"),
      underNewProject: addSession("in-new-project", null, "p-new"),
    };
    expect(svc.sweep(NOW)).toEqual({ incoming: 0, archived: 2 });
    expect(existsSync(folders.old)).toBe(false);
    expect(existsSync(folders.underOldProject)).toBe(false);
    expect(existsSync(folders.recent)).toBe(true);
    expect(existsSync(folders.live)).toBe(true);
    expect(existsSync(folders.underNewProject)).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps tidying when one folder can't be removed",
    () => {
      const stuck = addSession("a-stuck", ago(45));
      const other = addSession("b-other", ago(45));
      chmodSync(stuck, 0o500); // its file can't be unlinked
      try {
        expect(svc.sweep(NOW)).toEqual({ incoming: 0, archived: 1 });
        expect(existsSync(join(stuck, "a.png"))).toBe(true);
        expect(existsSync(other)).toBe(false);
      } finally {
        chmodSync(stuck, 0o700);
      }
    },
  );
});
