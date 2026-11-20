import { defaultSettings, type RunnerCommandName, type RunnerCommandOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerCommandError } from "../src/runner/client";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import {
  cleanupDue,
  cleanupInboxId,
  WorktreeCleanup,
} from "../src/services/sessions/worktree-cleanup";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
let cleanup: WorktreeCleanup;
let failWith: Error | null;
let archivedAt: string | null;
let settings: ReturnType<typeof defaultSettings>;
let connected: boolean;
/** The `force` flag of every `workspace.remove`. */
let forces: boolean[];

beforeEach(() => {
  env = createGithubEnv();
  failWith = new RunnerCommandError("worktree_in_use", "A file in the worktree is in use");
  archivedAt = null;
  settings = defaultSettings();
  connected = true;
  forces = [];
  const runner = {
    isConnected: () => connected,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      if (command.name !== "workspace.remove") return {};
      forces.push(command.force === true);
      if (failWith) throw failWith;
      return { removed: true };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  cleanup = new WorktreeCleanup({
    repo: env.repo,
    projects: {
      get: () => ({ ...env.githubProject, archivedAt }),
      list: () => [{ ...env.githubProject, archivedAt }],
    } as unknown as ProjectService,
    runner,
    store: env.store,
    settings: () => settings,
    stopSession: async () => undefined,
    inbox: env.inbox,
    sleep: async () => undefined,
  });
});

afterEach(() => env.close());

describe("worktrees of an archived project (#7)", () => {
  async function archiveProjectWithFailedRemoval() {
    // Recently active: not due by the inactivity setting.
    const session = env.addSession({ title: "Fix login", updatedAt: new Date().toISOString() });
    archivedAt = new Date().toISOString();
    const first = await cleanup.cleanProject(env.githubProject.id);
    expect(first.removed).toEqual([]);
    expect(env.inbox.find(cleanupInboxId(session.id))?.body).toContain(
      "CodeDen tries again every hour",
    );
    // The file is no longer in use: the next hourly sweep should finish the job.
    failWith = null;
    return session;
  }

  it("are retried by the hourly sweep after the archive-time removal failed", async () => {
    const session = await archiveProjectWithFailedRemoval();
    expect(await cleanup.sweep()).toEqual([session.id]);
    expect(env.repo.get(session.id).worktreeRemovedAt).not.toBeNull();
  });

  it("are retried even with automatic cleanup off", async () => {
    settings = { ...settings, worktrees: { ...settings.worktrees, cleanup: false } };
    const session = await archiveProjectWithFailedRemoval();
    expect(await cleanup.sweep()).toEqual([session.id]);
  });

  it("removes a session's worktree once it stops, when it was working at archive time", async () => {
    const session = env.addSession({ status: "running", updatedAt: new Date().toISOString() });
    archivedAt = new Date().toISOString();
    failWith = null;
    expect((await cleanup.cleanProject(env.githubProject.id)).removed).toEqual([]);
    expect(await cleanup.sweep()).toEqual([]);
    env.repo.update(session.id, (s) => ({ ...s, status: "stopped" }));
    expect(await cleanup.sweep()).toEqual([session.id]);
  });

  it("retries once the runner is back, when it was away at archive time", async () => {
    const session = env.addSession({ updatedAt: new Date().toISOString() });
    archivedAt = new Date().toISOString();
    failWith = null;
    connected = false;
    expect((await cleanup.cleanProject(env.githubProject.id)).removed).toEqual([]);
    expect(await cleanup.sweep()).toEqual([]);
    connected = true;
    expect(await cleanup.sweep()).toEqual([session.id]);
  });

  it("keeps a worktree with uncommitted changes, never forcing it", async () => {
    const session = env.addSession({ updatedAt: new Date().toISOString() });
    archivedAt = new Date().toISOString();
    failWith = new RunnerCommandError("worktree_dirty", "has uncommitted changes");
    expect(await cleanup.sweep()).toEqual([]);
    expect(env.repo.get(session.id).worktreeRemovedAt).toBeNull();
    expect(forces).toEqual([false]);
    expect(env.inbox.find(cleanupInboxId(session.id))).toBeUndefined();
  });

  it("leaves recent sessions of a project that is not archived alone", async () => {
    const session = env.addSession({ updatedAt: new Date().toISOString() });
    failWith = null;
    expect(await cleanup.sweep()).toEqual([]);
    const off = { ...settings.worktrees, cleanup: false };
    const archived = new Set([env.githubProject.id]);
    expect(cleanupDue(session, new Date(), off)).toBe(false);
    expect(cleanupDue(session, new Date(), off, archived)).toBe(true);
    expect(cleanupDue({ ...session, status: "running" }, new Date(), off, archived)).toBe(false);
  });
});
