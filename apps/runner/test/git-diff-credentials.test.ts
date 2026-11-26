import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialArgs, credentialEnv, scrubCredential } from "../src/git/credentials";
import { diffTrees, parseNameStatus, parseNumStat } from "../src/git/diff";
import { makeRepo, removeDir, sh, write } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

describe("parseNameStatus", () => {
  it("parses added, modified, deleted, type-changed, renamed and copied entries", () => {
    const raw = [
      "A",
      "src/new.ts",
      "M",
      "src/edited.ts",
      "D",
      "src/removed.ts",
      "T",
      "src/link",
      "R100",
      "src/old name.ts",
      "src/new name.ts",
      "C085",
      "src/base.ts",
      "src/copy.ts",
      "X",
      "src/unknown.ts",
      "",
    ].join("\0");

    expect(parseNameStatus(Buffer.from(raw, "utf8"))).toEqual([
      { status: "added", path: "src/new.ts" },
      { status: "modified", path: "src/edited.ts" },
      { status: "deleted", path: "src/removed.ts" },
      { status: "type_changed", path: "src/link" },
      { status: "renamed", oldPath: "src/old name.ts", path: "src/new name.ts" },
      { status: "copied", oldPath: "src/base.ts", path: "src/copy.ts" },
      { status: "modified", path: "src/unknown.ts" },
    ]);
  });

  it("handles UTF-8 paths, newlines in filenames and empty output", () => {
    const raw = "A\0docs/café\nnotes.md\0";
    expect(parseNameStatus(raw)).toEqual([{ status: "added", path: "docs/café\nnotes.md" }]);
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("parseNumStat", () => {
  it("parses text counts, binary markers, and NUL-delimited renames", () => {
    const raw = [
      "12\t3\tsrc/app.ts",
      "-\t-\tassets/logo.png",
      "4\t1\t",
      "src/before.ts",
      "src/after.ts",
      "-\t-\t",
      "assets/old.bin",
      "assets/new.bin",
      "0\t9\tsrc/trimmed file.ts",
      "",
    ].join("\0");

    expect(parseNumStat(Buffer.from(raw, "utf8"))).toEqual([
      { path: "src/app.ts", additions: 12, deletions: 3, binary: false },
      { path: "assets/logo.png", additions: 0, deletions: 0, binary: true },
      { path: "src/after.ts", additions: 4, deletions: 1, binary: false },
      { path: "assets/new.bin", additions: 0, deletions: 0, binary: true },
      { path: "src/trimmed file.ts", additions: 0, deletions: 9, binary: false },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNumStat("")).toEqual([]);
  });
});

describe("diffTrees", () => {
  it("reports added, modified, deleted, renamed and binary files and supports path filtering", async () => {
    const repo = makeRepo({
      "keep.txt": "line1\nline2\n",
      "remove.txt": "gone\n",
      "rename-me.txt": "identical content across rename\nline two\nline three\n",
    });
    dirs.push(repo);
    const base = sh(repo, "rev-parse", "HEAD");

    write(repo, "keep.txt", "line1\nchanged\nadded\n");
    rmSync(join(repo, "remove.txt"));
    sh(repo, "mv", "rename-me.txt", "renamed.txt");
    write(repo, "brand-new.txt", "hello\n");
    write(repo, "icon.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "changes");
    const head = sh(repo, "rev-parse", "HEAD");

    const full = await diffTrees(repo, base, head);
    const byPath = new Map(full.files.map((f) => [f.path, f]));
    expect(byPath.get("brand-new.txt")).toEqual({
      path: "brand-new.txt",
      status: "added",
      additions: 1,
      deletions: 0,
      binary: false,
    });
    expect(byPath.get("keep.txt")).toEqual({
      path: "keep.txt",
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
    });
    expect(byPath.get("remove.txt")).toEqual({
      path: "remove.txt",
      status: "deleted",
      additions: 0,
      deletions: 1,
      binary: false,
    });
    expect(byPath.get("renamed.txt")).toEqual({
      path: "renamed.txt",
      oldPath: "rename-me.txt",
      status: "renamed",
      additions: 0,
      deletions: 0,
      binary: false,
    });
    expect(byPath.get("icon.bin")).toEqual({
      path: "icon.bin",
      status: "added",
      additions: 0,
      deletions: 0,
      binary: true,
    });
    expect(full.diff).toContain("diff --git a/keep.txt b/keep.txt");

    const filtered = await diffTrees(repo, base, head, ["keep.txt"]);
    expect(filtered.files.map((f) => f.path)).toEqual(["keep.txt"]);
    expect(filtered.diff).not.toContain("brand-new.txt");
  });
});

describe("git credentials helpers", () => {
  const credential = {
    scope: "https://github.com",
    username: "x-access-token",
    password: "ghs_$pecial+token*[1]?",
  };

  it("clears configured helpers and scopes the inline helper to the credential's host", () => {
    const args = credentialArgs(credential);
    expect(args.slice(0, 3)).toEqual(["-c", "credential.helper=", "-c"]);
    expect(args[3]).toMatch(/^credential\.https:\/\/github\.com\.helper=!/);
    expect(args[3]).not.toContain(credential.password);
    expect(credentialEnv(credential)).toEqual({
      GIT_BROKER_USERNAME: credential.username,
      GIT_BROKER_PASSWORD: credential.password,
    });
  });

  it("scrubs every copy of a password including regex metacharacters", () => {
    const text = `fatal: https://x:${credential.password}@github.com failed (${credential.password})`;
    expect(scrubCredential(text, credential)).toBe("fatal: https://x:***@github.com failed (***)");
    expect(scrubCredential("plain git error", credential)).toBe("plain git error");
    expect(scrubCredential(text, undefined)).toBe(text);
  });
});
