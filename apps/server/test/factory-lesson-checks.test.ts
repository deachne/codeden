import type { FactoryItem, ReviewVerdictInit } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LESSON_CHECK_SYSTEM } from "../src/services/factory/lesson-checks";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Suggesting an automatic check for a lesson that came back (§10.1, #195): one card for two
 * lessons that say the same thing (judged by the scripted utility model), yes files an issue,
 * dismissing stops the suggestion, and different or once-seen lessons raise nothing.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, verifying, review, enable } = factorySteps(() => env);

const CHANGELOG = "Every user-facing change adds a changelog fragment in changes/.";
const CHANGELOG_AGAIN = "Remember a changes/ file for each change a user can see.";
const FOCUSED = "Run the focused test file before the whole suite.";

const withLessons = (...lessons: string[]): ReviewVerdictInit => ({ ...APPROVE, lessons });
const lessons = () => env.factory.data.lessons(env.project.id);
const idOf = (text: string) => lessons().find((l) => l.text === text)?.id as string;
const cards = (status: "open" | "resolved" | "dismissed" = "open") =>
  env.inbox.list({ status }).filter((i) => i.kind === "lesson_check");

/** The utility model's prompts for lesson checks, and what it answers (by lesson text). */
let asked: string[];
let answer: (prompt: string) => string | null;

/** A model that says the new lesson matches the listed lesson `match` names, with a check kind. */
const matches =
  (match: string | null, check = "lint rule") =>
  () => {
    const id = match ? idOf(match) : null;
    return JSON.stringify({ same: id, check, why: "Changelog notes keep being forgotten." });
  };

async function start() {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 12 } });
  asked = [];
  answer = () => null;
  env.model = async (system, prompt) => {
    if (system !== LESSON_CHECK_SYSTEM) return null;
    asked.push(prompt);
    return answer(prompt);
  };
  await enable("software_factory", { autoMerge: false });
}

/** Item `issue`, built and reviewed with these lessons; it took `rounds` revise rounds. */
async function reviewed(issue: number, rounds: number, ...texts: string[]) {
  const built = await verifying("success", `Work ${issue}`, issue);
  env.factory.data.updateItem(built.id, (i: FactoryItem) => ({ ...i, attempts: rounds }));
  await review(built.id, withLessons(...texts));
  return built;
}

describe("suggested checks for repeated lessons", () => {
  it("raise one card naming both lessons and their fix rounds, then file an issue on yes", async () => {
    await start();
    await reviewed(3, 2, CHANGELOG);
    expect(asked).toHaveLength(0); // the first lesson has nothing to match
    expect(cards()).toHaveLength(0);

    answer = matches(CHANGELOG);
    await reviewed(4, 1, CHANGELOG_AGAIN);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(CHANGELOG);
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card?.notify).toBe("factory");
    expect(card?.title).toContain("lint rule");
    expect(card?.body).toContain(CHANGELOG);
    expect(card?.body).toContain(CHANGELOG_AGAIN);
    expect(card?.body).toContain("3 fix rounds so far (issue #3: 2, issue #4: 1)");

    // Another lesson, not like the first two, never makes a second card.
    answer = () => JSON.stringify({ same: null, check: "test", why: "" });
    await reviewed(5, 0, FOCUSED);
    expect(cards()).toHaveLength(1);

    // Yes files one ordinary issue (nothing is built or merged by it), and saying yes again
    // finds it.
    const filedBefore = env.gh.issues.length;
    const issue = await env.factory.acceptLessonCheck(env.project.id, idOf(CHANGELOG));
    expect(env.gh.issues).toHaveLength(filedBefore + 1);
    const filed = env.gh.issues.at(-1);
    expect(filed?.labels).toContain("codeden-factory");
    expect(filed?.body).toContain(CHANGELOG);
    expect(filed?.body).toContain(CHANGELOG_AGAIN);
    expect(filed?.body).toContain("lint rule");
    expect(cards()).toHaveLength(0);
    expect(cards("resolved")).toHaveLength(1);
    expect(await env.factory.acceptLessonCheck(env.project.id, idOf(CHANGELOG_AGAIN))).toEqual(
      issue,
    );
    expect(env.gh.issues).toHaveLength(filedBefore + 1);
  });

  it("stop suggesting for the lessons of a dismissed card", async () => {
    await start();
    await reviewed(3, 1, CHANGELOG);
    answer = matches(CHANGELOG);
    await reviewed(4, 1, CHANGELOG_AGAIN);
    const [card] = cards();
    env.inbox.close(card as NonNullable<typeof card>, "dismissed", null);
    const asks = asked.length;

    // A third, similar lesson isn't compared with the ones already suggested, nor does a
    // lesson that was dismissed get its issue filed.
    await reviewed(5, 1, "Add a changes/ note for every visible change.");
    expect(asked.length).toBe(asks);
    expect(cards()).toHaveLength(0);
    expect(cards("dismissed")).toHaveLength(1);
    await expect(env.factory.acceptLessonCheck(env.project.id, idOf(CHANGELOG))).rejects.toThrow(
      /not waiting/,
    );
  });

  it("raise nothing for lessons that differ, an unusable answer or a model that fails", async () => {
    await start();
    await reviewed(3, 1, CHANGELOG);
    answer = () => JSON.stringify({ same: null, check: "test", why: "Different advice." });
    await reviewed(4, 1, FOCUSED);
    answer = () => "I think they match.";
    await reviewed(5, 1, "Keep files under 400 lines.");
    answer = () => JSON.stringify({ same: "not-a-lesson", check: "test", why: "x" });
    await reviewed(6, 1, "Use plain TypeScript.");
    answer = () => {
      throw new Error("model down");
    };
    const last = await reviewed(7, 1, "Name tests after the behaviour.");
    expect(asked.length).toBeGreaterThan(0);
    expect(cards()).toHaveLength(0);
    expect(lessons().every((l) => !l.checkSuggestion)).toBe(true);
    // The verdict stood whatever the model did.
    expect(item(last.id).review?.verdict).toBe("approve");
  });

  it("suggest a check for a lesson recorded again by other work, without asking for a match", async () => {
    await start();
    await reviewed(3, 2, FOCUSED);
    expect(cards()).toHaveLength(0);
    answer = () =>
      JSON.stringify({ same: null, check: "test", why: "It is a rule a test can hold." });
    await reviewed(4, 1, "run the focused   test file before the whole suite");
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card?.title).toContain("test");
    expect(card?.body).toContain("recorded this lesson again");
    expect(card?.body).toContain("3 fix rounds so far (issue #3: 2, issue #4: 1)");
    // The same work saying it again isn't a repeat, and a third time makes no second card.
    await reviewed(5, 0, FOCUSED);
    expect(cards()).toHaveLength(1);
  });

  it("never compare forgotten lessons, and close the card when one is forgotten", async () => {
    await start();
    await reviewed(3, 1, CHANGELOG);
    env.factory.forgetLesson(env.project.id, idOf(CHANGELOG));
    answer = () => JSON.stringify({ same: null, check: "test", why: "" });
    await reviewed(4, 1, CHANGELOG_AGAIN);
    expect(asked).toHaveLength(0); // nothing left to compare with
    await reviewed(5, 1, FOCUSED);
    answer = matches(CHANGELOG_AGAIN);
    await reviewed(6, 1, "Run the focused test file first, then the whole suite.");
    expect(asked.at(-1)).not.toContain(CHANGELOG); // the forgotten lesson wasn't offered
    expect(cards()).toHaveLength(1);
    env.factory.forgetLesson(env.project.id, idOf(CHANGELOG_AGAIN));
    expect(cards()).toHaveLength(0);
    expect(cards("dismissed")).toHaveLength(1);
  });

  it('never offer a retired lesson, and say "earlier work" when a lesson\'s work is gone', async () => {
    await start();
    const saved = (id: string, text: string) =>
      env.factory.data.saveLesson({
        id,
        projectId: env.project.id,
        text,
        key: text.toLowerCase(),
        itemId: `gone-${id}`,
        prNumber: null,
        reviewerProvider: null,
        times: 1,
        createdAt: env.now().toISOString(),
        lastSeenAt: env.now().toISOString(),
        removedAt: null,
      });
    // Advice kept before CodeDen retired it is in the store but in no one's hands.
    saved("old", "Unset CODEDEN_HOME before running tests.");
    answer = () => JSON.stringify({ same: "old", check: "test", why: "x" });
    await reviewed(3, 1, "Clear CODEDEN_* variables before you run the test suite.");
    expect(asked).toHaveLength(0); // the retired lesson was the only other one: nothing to compare
    expect(cards()).toHaveLength(0);

    // A real earlier lesson whose work item is gone is named "earlier work", never the current item.
    saved("earlier", CHANGELOG);
    answer = () => JSON.stringify({ same: "earlier", check: "lint rule", why: "x" });
    await reviewed(4, 2, CHANGELOG_AGAIN);
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain("CODEDEN_HOME");
    expect(cards()[0]?.body).toContain("2 fix rounds so far (earlier work: 0, issue #4: 2)");
  });

  it("raise nothing while learning from reviews is off", async () => {
    await start();
    await reviewed(3, 1, CHANGELOG);
    await enable("software_factory", { autoMerge: false, tuning: { learnFromReviews: false } });
    answer = matches(CHANGELOG);
    await reviewed(4, 1, CHANGELOG_AGAIN);
    expect(cards()).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });
});
