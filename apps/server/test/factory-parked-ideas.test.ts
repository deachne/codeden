import type { ParkedIdea, Session } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceError } from "../src/services/errors";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Parked ideas (#81): the scout's good-but-not-filed ideas. They are saved in the project's list
 * and copied to the owner's Ideas repository; the copy is best effort and never blocks anything.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);

const loop = () => env.factory.data.loopOrNew(env.project.id);
const scout = () => env.repo.get(loop().scout.sessionId as string) as Session;
const code = (run: () => unknown) =>
  Promise.resolve()
    .then(run)
    .then(
      () => "ok",
      (error: ServiceError) => error.code,
    );
const idea = (title: string) => ({
  title,
  whyLiked: "It saves you a step every day.",
  whyParked: "Smaller than the three picked this round.",
});
const sync = async () => {
  // Let the background copy settle.
  await env.factory.syncParkedIdeas();
};

async function startRound() {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 4 } });
  s.enable("dark_factory", {
    tuning: { minBacklog: 2, maxIssuesPerRound: 2, discoveryPerRound: 1 },
  });
  await s.tick();
  expect(loop().scout.round).toBeTruthy();
}
const listed = () => env.factory.parkedIdeas(env.project.id);

describe("parked ideas", () => {
  it("saves an idea once with both reasons, and copies it once to the Ideas repository", async () => {
    await startRound();
    const first = env.factory.parkIdea(scout(), idea("Show what each agent run cost"));
    expect(first.duplicate).toBe(false);
    // The same title again (any case or trailing dot) changes nothing.
    expect(env.factory.parkIdea(scout(), idea("show what each agent run cost.")).duplicate).toBe(
      true,
    );
    await sync();
    await sync();
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toMatchObject({
      status: "parked",
      whyLiked: "It saves you a step every day.",
      whyParked: "Smaller than the three picked this round.",
    });
    expect(env.gh.ideas).toHaveLength(1);
    expect(env.gh.ideas[0]).toMatchObject({ repo: "deachne/ideas", labels: ["codeden"] });
    expect(env.gh.ideas[0]?.body).toMatch(/^Parked \d{4}-\d{2}-\d{2}/);
    expect(listed()[0]?.ideasIssue?.number).toBe(env.gh.ideas[0]?.number);
    expect((await env.factory.status(env.project.id)).parkedIdeaCount).toBe(1);
  });

  it("rejects a parked idea missing a reason, and only lets the scout park", async () => {
    await startRound();
    expect(await code(() => env.factory.parkIdea(scout(), { ...idea("A"), whyParked: "  " }))).toBe(
      "missing_reason",
    );
    expect(
      await code(() => env.factory.parkIdea({ ...scout(), id: "not-the-scout" }, idea("B"))),
    ).toBe("not_the_scout");
  });

  it("keeps the list when GitHub is down and copies the idea on a later try", async () => {
    await startRound();
    env.gh.ideasDown = true;
    env.factory.parkIdea(scout(), idea("Warn me before the budget runs out"));
    await sync();
    expect(listed()).toHaveLength(1);
    expect(listed()[0]?.ideasIssue).toBeNull();
    expect(env.gh.ideas).toHaveLength(0);
    env.gh.ideasDown = false;
    await sync();
    expect(env.gh.ideas).toHaveLength(1);
    expect(listed()[0]?.ideasIssue).not.toBeNull();
  });

  it("Not now hides it and labels the Ideas issue someday; Build it files a factory issue", async () => {
    await startRound();
    env.factory.parkIdea(scout(), idea("First idea of the week"));
    env.factory.parkIdea(scout(), idea("Second idea of the week"));
    await sync();
    const [a, b] = listed() as [ParkedIdea, ParkedIdea];
    env.factory.setParkedIdeaAside(env.project.id, a.id);
    await sync();
    expect(listed().map((i) => i.id)).toEqual([b.id]);
    expect(env.gh.ideas.find((i) => i.number === a.ideasIssue?.number)?.labels).toContain(
      "someday",
    );

    const built = await env.factory.buildParkedIdea(env.project.id, b.id);
    expect(built.status).toBe("building");
    expect(built.builtIssue).not.toBeNull();
    expect(env.gh.issues.some((i) => i.title === b.title)).toBe(true);
    await sync();
    expect(env.gh.ideas.find((i) => i.number === b.ideasIssue?.number)?.comments[0]).toContain(
      built.builtIssue?.url,
    );
    // Building it twice files nothing more; a building idea can't be set aside.
    await env.factory.buildParkedIdea(env.project.id, b.id);
    expect(env.gh.issues.filter((i) => i.title === b.title)).toHaveLength(1);
    expect(await code(() => env.factory.setParkedIdeaAside(env.project.id, b.id))).toBe(
      "parked_idea_building",
    );
    expect(listed()).toHaveLength(0);
    expect((await env.factory.status(env.project.id)).parkedIdeaCount).toBe(0);
  });

  it("hides an untouched idea after 60 days without deleting it", async () => {
    await startRound();
    env.factory.parkIdea(scout(), idea("An old idea nobody opened"));
    expect(listed()).toHaveLength(1);
    const saved = env.factory.data.parkedIdeas(env.project.id)[0] as ParkedIdea;
    env.factory.data.saveParkedIdea({
      ...saved,
      createdAt: new Date(Date.now() - 61 * 86_400_000).toISOString(),
    });
    expect(listed()).toHaveLength(0);
    expect(env.factory.data.parkedIdeas(env.project.id)[0]?.status).toBe("parked");
  });
});
