import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(() => env.close());

function setup() {
  const session = env.addSession({
    pr: { number: 7, url: "https://github.com/acme/widgets/pull/7", state: "open" },
  });
  for (let i = 0; i < 6; i++) env.gh.addIssue();
  env.gh.addPr("codeden/task-1");
  return session;
}

describe("evidence file extensions", () => {
  it("keeps .png when a path file gets a name without an ending", async () => {
    const session = setup();
    writeFileSync(join(env.dir, "shot.png"), PNG);
    const result = await env.service.attachEvidence(session.id, {
      files: [{ path: "shot.png", name: "sidebar-states" }],
    });
    expect(result.files[0]?.name).toBe("sidebar-states.png");
    const comment = env.gh.issues.get(7)?.comments.at(-1)?.body ?? "";
    expect(comment).toContain("![");
  });

  it("keeps .png when an artifact's name has no ending", async () => {
    const session = setup();
    const artifact = env.artifacts.save({
      bytes: PNG,
      name: "sidebar-states",
      mediaType: "image/png",
      kind: "screenshot",
      projectId: "p-gh",
      sessionId: session.id,
    });
    const result = await env.service.attachEvidence(session.id, {
      files: [{ artifactId: artifact.id }],
    });
    expect(result.files[0]?.name).toBe("sidebar-states.png");
    expect(env.gh.issues.get(7)?.comments.at(-1)?.body ?? "").toContain("![");
  });
});
