import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// A builder started with release mode on, before any release branch existed, failed at its
// worktree ("invalid reference: release"). The branch is now created first.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem } = factorySteps(() => env);

describe("a builder with release mode on and no release branch yet", () => {
  it("creates the branch from the default branch, then starts", async () => {
    env = await createFactoryEnv();
    enable("software_factory", { tuning: { releaseMode: true, releaseBranch: "release" } });
    env.gh.branches.delete("release");
    const created = backlogItem();
    await tick();
    expect(env.gh.branches.has("release")).toBe(true);
    const start = env.starts.find((s) => s.workKey === "issue:3");
    expect(start?.workspace).toMatchObject({ baseRef: "release" });
    expect(item(created.id).stage).toBe("building");
  });

  it("waits with a plain note when the branch can't be created", async () => {
    env = await createFactoryEnv();
    enable("software_factory", { tuning: { releaseMode: true, releaseBranch: "release" } });
    env.gh.branches.delete("release");
    env.gh.ensureBranch = async () => {
      throw new Error("GitHub refused (403)");
    };
    const created = backlogItem();
    await tick();
    expect(env.starts.filter((s) => s.workKey === "issue:3")).toHaveLength(0);
    expect(item(created.id).stage).toBe("backlog");
    expect(item(created.id).note).toContain("Could not create the release branch: GitHub refused");
  });
});
