import { describe, expect, it } from "vitest";
import { revertedPrompt } from "../src/services/factory/prompts-revert";

describe("revertedPrompt", () => {
  it("tells create_pull_request which base to use", () => {
    for (const branch of ["release/next", "main"]) {
      const text = revertedPrompt({
        branch,
        prNumber: 5,
        mergeSha: "abc1234",
        failed: [],
        revertPr: 6,
        revertSha: "def5678",
      });
      expect(text).toContain(`passing \`base: "${branch}"\``);
    }
  });
});
