import { afterEach, describe, expect, it, vi } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

describe("tickAll skips settled stopped loops", () => {
  it("does not tick a project outside factory mode whose loop is stopped with no drain", async () => {
    env = createFactoryEnv();
    const id = env.project.id;
    env.factory.data.saveLoop({ ...env.factory.data.loopOrNew(id), state: "stopped", drain: null });
    const spy = vi.spyOn(env.factory, "tick");
    await env.factory.tickAll();
    expect(spy).not.toHaveBeenCalled();
  });

  it("still ticks a stopped loop that is draining", async () => {
    env = createFactoryEnv();
    const id = env.project.id;
    const loop = env.factory.data.loopOrNew(id);
    env.factory.data.saveLoop({
      ...loop,
      state: "stopped",
      drain: { startedAt: new Date().toISOString(), deadline: null } as never,
    });
    const spy = vi.spyOn(env.factory, "tick");
    await env.factory.tickAll();
    expect(spy).toHaveBeenCalledWith(id);
  });

  it("still ticks a stopped loop with an unfinished manual owner-check run", async () => {
    env = createFactoryEnv();
    const id = env.project.id;
    env.factory.data.saveLoop({ ...env.factory.data.loopOrNew(id), state: "stopped", drain: null });
    vi.spyOn(env.factory.data.ownerChecks, "followUpRuns").mockReturnValue([{} as never]);
    const spy = vi.spyOn(env.factory, "tick");
    await env.factory.tickAll();
    expect(spy).toHaveBeenCalledWith(id);
  });
});
