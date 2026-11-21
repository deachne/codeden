import { describe, expect, it } from "vitest";
import { askUser } from "../src/mcp/tools/ask-user";
import { DECISION_PLAIN_WORDS_RULE } from "../src/services/factory/prompts-plain-words";
import { UNATTENDED_ANSWER } from "../src/services/factory/unattended";

function run(plainWords: boolean) {
  const services = { factory: { isUnattended: () => true, asksPlainWords: () => plainWords } };
  // biome-ignore lint/suspicious/noExplicitAny: a minimal stand-in for the services the tool reads
  return askUser.handler({ question: "q" } as any, { services, sessionId: "s" } as any);
}

describe("unattended answer and plain words", () => {
  it("adds the plain-words rule only when the project asks for it", async () => {
    expect(await run(true)).toBe(`${UNATTENDED_ANSWER}\n${DECISION_PLAIN_WORDS_RULE}`);
    expect(await run(false)).toBe(UNATTENDED_ANSWER);
  });
});
