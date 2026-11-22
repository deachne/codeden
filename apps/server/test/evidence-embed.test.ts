import { describe, expect, it } from "vitest";
import { GithubFactoryPort } from "../src/services/factory/github-port";
import type { GithubService } from "../src/services/github/github-service";

function portWith(body: string) {
  const github = {
    connection: async () => ({ login: "darcy" }),
    githubRepo: () => ({ owner: "acme", repo: "app" }),
    client: {
      run: async () => [{ body, user: { login: "darcy" } }],
    },
  } as unknown as GithubService;
  return new GithubFactoryPort(github);
}

const HEADING = "### Evidence from CodeDen";

describe("evidence() screenshots", () => {
  it("counts an inline image embed even when the file name has no ending", async () => {
    const body = `${HEADING}\n\n![Sidebar](https://github.com/a/b/blob/abc/pr-1/s/sidebar-states?raw=true)`;
    expect(await portWith(body).evidence("p", 1, null)).toMatchObject({ screenshots: true });
  });

  it("doesn't count a plain link to a file without an image ending", async () => {
    const body = `${HEADING}\n\n- [sidebar-states](https://github.com/a/b/blob/abc/pr-1/s/sidebar-states?raw=true)`;
    expect(await portWith(body).evidence("p", 1, null)).toMatchObject({ screenshots: false });
  });
});
