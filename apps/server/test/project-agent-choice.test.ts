import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProjectAgentChoice,
  type ProviderInfo,
  Settings,
  type SettingsInput,
  StartSessionRequest,
  type StartSessionRequestInit,
} from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { checkChoice, projectChoiceFor } from "../src/services/projects/project-agent";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { removeTree } from "./support/remove-tree";

// #178: a project's own provider, model and effort for its PM and its workers.

const caps = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: false,
} as ProviderInfo["capabilities"];

const model = (id: string) => ({ id, label: id, efforts: [] as never[] });

const claude: ProviderInfo = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: caps,
  models: [model("opus"), model("haiku")],
};
const cursor: ProviderInfo = {
  id: "cursor",
  displayName: "Cursor",
  capabilities: caps,
  models: [model("deepseek-v4"), model("auto")],
};
/** A provider whose model list depends on the project: it can't be checked from the server. */
const opencode: ProviderInfo = {
  id: "opencode",
  displayName: "OpenCode",
  capabilities: { ...caps, projectModels: true },
  models: [model("openai/gpt-5")],
};
/** A provider without effort levels. */
const plain: ProviderInfo = {
  id: "plain",
  displayName: "Plain",
  capabilities: { ...caps, reasoningEffort: false },
  models: [],
};

describe("projectChoiceFor", () => {
  const choice: ProjectAgentChoice = { provider: "claude", model: "opus", effort: null };
  const project = { pmChoice: choice, workerChoice: { ...choice, model: "haiku" } };

  it("gives the PM its choice and agent sessions the workers', and the orchestrator none", () => {
    expect(projectChoiceFor(project, "pm")).toBe(project.pmChoice);
    expect(projectChoiceFor(project, "agent")).toBe(project.workerChoice);
    expect(projectChoiceFor(project, "orchestrator")).toBeNull();
    expect(projectChoiceFor(null, "pm")).toBeNull();
    expect(projectChoiceFor({ pmChoice: null, workerChoice: null }, "agent")).toBeNull();
  });
});

describe("checkChoice: whether a project's choice can run now", () => {
  const env = (over: Partial<Parameters<typeof checkChoice>[1]> = {}) => ({
    providers: [claude, cursor, opencode],
    connected: true,
    ...over,
  });
  const pick = (provider: string, m: string | null) => ({ provider, model: m, effort: null });

  it("accepts a listed model, the provider's default and a custom model", () => {
    expect(checkChoice(pick("cursor", "deepseek-v4"), env()).usable).toBe(true);
    expect(checkChoice(pick("cursor", null), env()).usable).toBe(true);
    expect(checkChoice(pick("cursor", "default"), env()).usable).toBe(true);
    const customModels = { cursor: [{ id: "my-model" }] };
    expect(checkChoice(pick("cursor", "my-model"), env({ customModels })).usable).toBe(true);
  });

  it("refuses a model the tool no longer lists, in plain words", () => {
    expect(checkChoice(pick("cursor", "gone"), env())).toEqual({
      usable: false,
      problem: "Cursor no longer lists the model gone",
    });
  });

  it("refuses a tool the runner doesn't offer, or that is signed out", () => {
    expect(checkChoice(pick("gemini", null), env()).usable).toBe(false);
    const providerProblem = (id: string) => (id === "cursor" ? "Cursor is not signed in" : null);
    expect(checkChoice(pick("cursor", "auto"), env({ providerProblem }))).toEqual({
      usable: false,
      problem: "Cursor is not signed in",
    });
    expect(checkChoice(pick("claude", "opus"), env({ providerProblem })).usable).toBe(true);
  });

  it("trusts a list that depends on the project, and lets everything through while offline", () => {
    expect(checkChoice(pick("opencode", "my/own-model"), env()).usable).toBe(true);
    expect(checkChoice(pick("gemini", "x"), env({ connected: false })).usable).toBe(true);
  });
});

type Start = (over: Partial<StartSessionRequestInit>) => Promise<string>;

interface World {
  pmChoice?: ProjectAgentChoice | null;
  workerChoice?: ProjectAgentChoice | null;
  defaultProvider?: string | null;
  settings?: SettingsInput;
  /** Tools that are signed out, by id. */
  signedOut?: string[];
}

/** A SessionService over a real database, with a scripted runner, project and settings. */
function withWorld(
  world: World,
  run: (start: Start, repo: SessionRepo, puts: string[]) => Promise<void>,
) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-project-choice-"));
    const database = openDatabase(join(dir, "codeden.db"));
    try {
      const repo = new SessionRepo(database.db, new EventStore(database.db));
      const parsed = Settings.parse(world.settings ?? {});
      const puts: string[] = [];
      const items = new Map<string, { status: string; body: string }>();
      const sessions = new SessionService({
        repo,
        projects: {
          get: () => ({
            id: "p1",
            name: "Barn",
            path: dir,
            defaultProvider: world.defaultProvider ?? null,
            pmChoice: world.pmChoice ?? null,
            workerChoice: world.workerChoice ?? null,
            archivedAt: null,
            autonomy: null,
          }),
        },
        runner: { providers: () => [claude, cursor, opencode, plain], isConnected: () => true },
        settings: { get: () => parsed },
        launcher: { launch: vi.fn(async () => {}) },
        inbox: {
          find: (id: string) => items.get(id),
          put: (item: { id: string; status: string; body: string }) => {
            items.set(item.id, item);
            puts.push(item.body);
          },
        },
        providerProblem: (id: string) =>
          world.signedOut?.includes(id) ? `${id} is not signed in` : null,
      } as unknown as SessionServiceDeps);
      const start: Start = async (over) => {
        const res = await sessions.start(
          StartSessionRequest.parse({ projectId: "p1", purpose: `Work ${Math.random()}`, ...over }),
        );
        if (res.status !== "started") throw new Error(res.status);
        return res.sessionId;
      };
      await run(start, repo, puts);
    } finally {
      database.close();
      await removeTree(dir);
    }
  };
}

const worker = (provider: string, m: string | null, effort: ProjectAgentChoice["effort"] = null) =>
  ({ provider, model: m, effort }) satisfies ProjectAgentChoice;

describe("SessionService.start: explicit > project choice > shared setting", () => {
  const shared: SettingsInput = {
    providers: {
      agent: { provider: "claude", model: "opus", effort: "high" },
      pm: { provider: "claude", model: "opus", effort: "high" },
    },
  };

  it(
    "starts a worker on the project's workers' choice when the start names nothing",
    withWorld(
      { workerChoice: worker("cursor", "deepseek-v4", "low"), settings: shared },
      async (start, repo) => {
        const id = await start({});
        expect(repo.get(id)).toMatchObject({
          provider: "cursor",
          model: "deepseek-v4",
          effort: "low",
        });
      },
    ),
  );

  it(
    "starts the PM on the PM choice, and workers on theirs, independently",
    withWorld(
      {
        pmChoice: worker("claude", "haiku"),
        workerChoice: worker("cursor", "auto"),
        settings: shared,
      },
      async (start, repo) => {
        const pm = await start({ role: "pm", workspace: { mode: "repo_root" } });
        expect(repo.get(pm)).toMatchObject({ provider: "claude", model: "haiku", effort: null });
        const agent = await start({});
        expect(repo.get(agent)).toMatchObject({ provider: "cursor", model: "auto" });
      },
    ),
  );

  it(
    "lets a start's own provider and model win over the project's choice",
    withWorld(
      { workerChoice: worker("cursor", "deepseek-v4"), settings: shared },
      async (start, repo) => {
        // Another provider named: the choice's model doesn't follow it; the shared setting does.
        const other = await start({ provider: "claude" });
        expect(repo.get(other)).toMatchObject({
          provider: "claude",
          model: "opus",
          effort: "high",
        });
        // Only a model named: it wins, on the project's provider.
        const named = await start({ model: "auto" });
        expect(repo.get(named)).toMatchObject({ provider: "cursor", model: "auto" });
        // Provider and model named.
        const both = await start({ provider: "claude", model: "haiku", effort: "low" });
        expect(repo.get(both)).toMatchObject({ provider: "claude", model: "haiku", effort: "low" });
      },
    ),
  );

  it(
    "follows the shared setting while the project has no choice, as before",
    withWorld({ settings: shared, defaultProvider: "claude" }, async (start, repo) => {
      const id = await start({});
      expect(repo.get(id)).toMatchObject({ provider: "claude", model: "opus", effort: "high" });
    }),
  );

  it(
    "takes the choice before the project's default provider, and drops an effort the tool lacks",
    withWorld(
      { workerChoice: worker("plain", null, "high"), defaultProvider: "claude", settings: shared },
      async (start, repo) => {
        const id = await start({});
        expect(repo.get(id)).toMatchObject({ provider: "plain", model: null, effort: null });
      },
    ),
  );

  it(
    "keeps the PM's choice off the workers, and the workers' off the PM",
    withWorld({ pmChoice: worker("cursor", "auto"), settings: shared }, async (start, repo) => {
      const agent = await start({});
      expect(repo.get(agent)).toMatchObject({ provider: "claude", model: "opus" });
    }),
  );
});

describe("SessionService.start: a choice that can't run", () => {
  const shared: SettingsInput = {
    providers: { agent: { provider: "claude", model: "opus", effort: "high" } },
  };

  it(
    "falls back to the shared setting for a model the tool dropped, and tells the owner once",
    withWorld(
      { workerChoice: worker("cursor", "gone"), settings: shared },
      async (start, repo, puts) => {
        const first = await start({});
        expect(repo.get(first)).toMatchObject({
          provider: "claude",
          model: "opus",
          effort: "high",
        });
        await start({});
        // One note, in plain words, however many sessions start.
        expect(puts).toHaveLength(1);
        expect(puts[0]).toContain("Cursor no longer lists the model gone");
        expect(puts[0]).toContain("Barn");
        expect(puts[0]).toContain("shared setting");
      },
    ),
  );

  it(
    "falls back when the tool is signed out, without failing the start",
    withWorld(
      { workerChoice: worker("cursor", "auto"), settings: shared, signedOut: ["cursor"] },
      async (start, repo, puts) => {
        const id = await start({});
        expect(repo.get(id)).toMatchObject({ provider: "claude", model: "opus" });
        expect(puts).toEqual([expect.stringContaining("cursor is not signed in")]);
      },
    ),
  );

  it(
    "says nothing when the start named another provider and never needed the choice",
    withWorld(
      { workerChoice: worker("cursor", "gone"), settings: shared },
      async (start, repo, puts) => {
        const id = await start({ provider: "claude" });
        expect(repo.get(id)).toMatchObject({ provider: "claude", model: "opus" });
        expect(puts).toEqual([]);
      },
    ),
  );

  it(
    "says nothing for a choice that runs",
    withWorld(
      { workerChoice: worker("cursor", "auto"), settings: shared },
      async (start, _r, puts) => {
        await start({});
        expect(puts).toEqual([]);
      },
    ),
  );
});
