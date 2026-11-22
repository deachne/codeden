import { describe, expect, it } from "vitest";
import { PreviewTarget, previewWorkKey, StartPreviewResult, StopPreviewResult } from "../src";

describe("preview contracts", () => {
  it("round-trips a started preview and a refusal", () => {
    const started = {
      status: "started",
      url: "http://127.0.0.1:5050",
      reachableFrom: "this-computer",
      sessionId: "s1",
      sessionLink: "/sessions/s1",
      message: "ok",
    };
    expect(StartPreviewResult.parse(JSON.parse(JSON.stringify(started)))).toEqual(started);
    const refused = {
      status: "no_dev_server",
      message: "Set a devServer in .codeden/project.json",
    };
    expect(StartPreviewResult.parse(refused)).toEqual(refused);
    const stopped = { status: "stopped", message: "ok" };
    expect(StopPreviewResult.parse(stopped)).toEqual(stopped);
  });

  it("needs a branch and gives a valid work key", () => {
    expect(PreviewTarget.safeParse({ branch: " " }).success).toBe(false);
    expect(previewWorkKey("feat/a b")).toBe("preview:feat/a-b");
  });
});
