import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArchiveSessionResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ worktreeCleanup: { initialDelayMs: 60 * 60_000 } });
});

afterAll(async () => {
  await h?.close();
});

const archive = async (id: string, body: unknown = {}) => {
  const res = await h.api("POST", `/sessions/${id}/archive`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ArchiveSessionResponse.parse(res.body);
};
const services = () => h.server.services;

describe("worktree cleanup: a session brought back by a message (#6)", () => {
  it("forgets an earlier forced archive, so the sweep keeps new uncommitted work", async () => {
    const id = await h.startFakeSession();
    const other = await h.startFakeSession();
    const worktree = (await h.detail(id)).session.worktreePath as string;
    const otherCwd = (await h.detail(other)).session.cwd;

    // A forced archive whose removal fails: another live session works in the same folder.
    services().sessionRepo.update(other, (s) => ({ ...s, cwd: worktree }));
    const refused = await archive(id, { force: true });
    expect(refused.worktree.status).toBe("failed");
    expect(existsSync(worktree)).toBe(true);
    services().sessionRepo.update(other, (s) => ({ ...s, cwd: otherCwd }));

    // A message brings the session back.
    const sent = await h.api("POST", `/sessions/${id}/messages`, { input: { text: "again" } });
    expect(sent.status).toBe(200);
    await waitUntil(async () => {
      const s = (await h.detail(id)).session;
      return s.status === "idle" && !s.archivedAt ? s : undefined;
    });

    // New uncommitted work, then an archive that does not force: the worktree is kept.
    writeFileSync(join(worktree, "new-work.txt"), "keep me\n");
    const kept = await archive(id);
    expect(kept.worktree.status).toBe("kept_changes");

    // The sweep must not reuse the old "Delete anyway" choice.
    expect(await services().worktreeCleanup.sweep()).not.toContain(id);
    expect(existsSync(join(worktree, "new-work.txt"))).toBe(true);
  });

  it("still finishes a forced archive whose removal failed, when nothing brought it back", async () => {
    const id = await h.startFakeSession();
    const other = await h.startFakeSession();
    const worktree = (await h.detail(id)).session.worktreePath as string;
    const otherCwd = (await h.detail(other)).session.cwd;
    writeFileSync(join(worktree, "discard-me.txt"), "throw away\n");

    services().sessionRepo.update(other, (s) => ({ ...s, cwd: worktree }));
    expect((await archive(id, { force: true })).worktree.status).toBe("failed");
    services().sessionRepo.update(other, (s) => ({ ...s, cwd: otherCwd }));

    expect(await services().worktreeCleanup.sweep()).toContain(id);
    expect(existsSync(worktree)).toBe(false);
  });
});
