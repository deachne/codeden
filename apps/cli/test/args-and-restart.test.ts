import { describe, expect, it } from "vitest";
import { parseCli } from "../src/args";
import { relaunchArgs } from "../src/restart";

describe("parseCli", () => {
  it("returns false defaults and empty positionals for an empty argument list", () => {
    const parsed = parseCli([]);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.values).toEqual({
      "no-open": false,
      install: false,
      rollback: false,
      generate: false,
      "loopback-only": false,
      version: false,
      help: false,
    });
  });

  it("parses short and long flags alongside string options and positionals", () => {
    expect(parseCli(["-v"]).values.version).toBe(true);
    expect(parseCli(["-h"]).values.help).toBe(true);
    expect(parseCli(["-vh"]).values).toMatchObject({ version: true, help: true });

    const parsed = parseCli([
      "network",
      "on",
      "--loopback-only",
      "--port",
      "4320",
      "--home=/tmp/codeden",
      "--no-open",
    ]);
    expect(parsed.positionals).toEqual(["network", "on"]);
    expect(parsed.values).toMatchObject({
      "loopback-only": true,
      port: "4320",
      home: "/tmp/codeden",
      "no-open": true,
      install: false,
      rollback: false,
      generate: false,
    });

    expect(parseCli(["doctor", "--install"]).values.install).toBe(true);
    expect(parseCli(["update", "--rollback"]).values.rollback).toBe(true);
    expect(parseCli(["password", "--generate"]).values.generate).toBe(true);
    expect(parseCli(["network", "origin", "add", "https://proxy.example"]).positionals).toEqual([
      "network",
      "origin",
      "add",
      "https://proxy.example",
    ]);
  });

  it("throws on unknown options or missing option values", () => {
    expect(() => parseCli(["--unknown-flag"])).toThrow();
    expect(() => parseCli(["-x"])).toThrow();
    expect(() => parseCli(["--port"])).toThrow();
    expect(() => parseCli(["--home"])).toThrow();
  });
});

describe("relaunchArgs", () => {
  it("appends --port and --no-open when given empty arguments", () => {
    expect(relaunchArgs([], 4317)).toEqual(["--port", "4317", "--no-open"]);
  });

  it("strips --port <n>, --port=<n>, and duplicate --no-open while preserving other flags and positionals", () => {
    expect(
      relaunchArgs(
        [
          "start",
          "--home",
          "/tmp/h",
          "--port",
          "4000",
          "--no-open",
          "--port=5000",
          "--loopback-only",
          "--no-open",
          "--home=/tmp/h2",
        ],
        4318,
      ),
    ).toEqual([
      "start",
      "--home",
      "/tmp/h",
      "--loopback-only",
      "--home=/tmp/h2",
      "--port",
      "4318",
      "--no-open",
    ]);
  });

  it("handles a trailing --port without a following value", () => {
    expect(relaunchArgs(["--home", "/tmp/h", "--port"], 4317)).toEqual([
      "--home",
      "/tmp/h",
      "--port",
      "4317",
      "--no-open",
    ]);
  });
});
