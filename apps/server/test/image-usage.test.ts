import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import { ImageUsageStore, localDate } from "../src/services/images/usage";
import { removeTree } from "./support/remove-tree";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-image-usage-"));
});

afterEach(async () => {
  await removeTree(dir);
});

describe("localDate", () => {
  it("formats local calendar dates with zero-padded month and day", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 11, 31, 0, 0, 0))).toBe("2026-12-31");
  });
});

describe("ImageUsageStore", () => {
  const usageFile = () => join(dir, "image-usage.json");

  it("resets total and byProject when the injected clock crosses local midnight", () => {
    let now = new Date(2026, 10, 25, 23, 59, 30);
    const store = new ImageUsageStore(usageFile(), () => now);

    store.reserve(3, { global: 5, project: 3 }, "proj-a");
    store.reserve(2, { global: 5, project: 3 }, "proj-b");
    expect(store.today()).toEqual({
      date: "2026-11-25",
      total: 5,
      byProject: { "proj-a": 3, "proj-b": 2 },
    });
    expect(() => store.reserve(1, { global: 5 }, "proj-a")).toThrow(ServiceError);

    // Cross local midnight into the next calendar day.
    now = new Date(2026, 10, 26, 0, 0, 1);
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 0,
      byProject: {},
    });

    // Previous day's counts no longer block reservations, and the new date is persisted.
    store.reserve(1, { global: 5, project: 3 }, "proj-a");
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 1,
      byProject: { "proj-a": 1 },
    });

    const reloaded = new ImageUsageStore(usageFile(), () => now);
    expect(reloaded.today()).toEqual({
      date: "2026-11-26",
      total: 1,
      byProject: { "proj-a": 1 },
    });
  });

  it("returns a defensive copy from today()", () => {
    const now = new Date(2026, 10, 26, 10, 0, 0);
    const store = new ImageUsageStore(usageFile(), () => now);
    store.reserve(2, { global: 10 }, "proj-a");

    const snapshot = store.today();
    snapshot.total = 999;
    snapshot.byProject["proj-a"] = 999;

    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 2,
      byProject: { "proj-a": 2 },
    });
  });

  it("handles reserve/release symmetry, clamping at 0, and release(0) as a no-op", () => {
    const now = new Date(2026, 10, 26, 10, 0, 0);
    const store = new ImageUsageStore(usageFile(), () => now);

    // release(0) and negative counts are no-ops and do not touch disk.
    store.release(0, "proj-a");
    store.release(-2, "proj-a");
    expect(existsSync(usageFile())).toBe(false);
    expect(store.today()).toEqual({ date: "2026-11-26", total: 0, byProject: {} });

    // Partial production: reserve 4, produce 1, release 3.
    store.reserve(4, { global: 10, project: 5 }, "proj-a");
    store.release(3, "proj-a");
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 1,
      byProject: { "proj-a": 1 },
    });

    // Releasing more than reserved clamps both total and project counts at 0.
    store.release(5, "proj-a");
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 0,
      byProject: { "proj-a": 0 },
    });

    // Release with null projectId updates total without adding a project key.
    store.reserve(2, { global: 10 }, null);
    store.release(1, null);
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 1,
      byProject: { "proj-a": 0 },
    });
    store.release(10, null);
    expect(store.today().total).toBe(0);
  });

  it("enforces per-project and global caps independently and persists across reloads", () => {
    let now = new Date(2026, 10, 26, 12, 0, 0);
    const store = new ImageUsageStore(usageFile(), () => now);

    store.reserve(2, { global: 5, project: 2 }, "proj-a");

    // Project A hit its per-project cap; global cap still has room.
    expect(() => store.reserve(1, { global: 5, project: 2 }, "proj-a")).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "daily_cap_reached",
        message: expect.stringMatching(/project's daily image cap \(2\)/),
      }),
    );
    // Rejected reservation does not mutate counts.
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 2,
      byProject: { "proj-a": 2 },
    });

    // Project B and projectless reservations still succeed up to the global cap.
    store.reserve(2, { global: 5, project: 2 }, "proj-b");
    store.reserve(1, { global: 5, project: 2 }, null);
    expect(store.today()).toEqual({
      date: "2026-11-26",
      total: 5,
      byProject: { "proj-a": 2, "proj-b": 2 },
    });

    // Reloading on the same day keeps persisted counts and enforces global cap.
    const sameDayReload = new ImageUsageStore(usageFile(), () => now);
    expect(sameDayReload.today()).toEqual({
      date: "2026-11-26",
      total: 5,
      byProject: { "proj-a": 2, "proj-b": 2 },
    });
    expect(() => sameDayReload.reserve(1, { global: 5, project: 10 }, "proj-c")).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "daily_cap_reached",
        message: expect.stringMatching(/daily image cap \(5\)/),
      }),
    );

    // Without a per-project cap, a project can reserve up to the global cap.
    sameDayReload.reserve(1, { global: 6 }, "proj-a");
    expect(sameDayReload.today().byProject["proj-a"]).toBe(3);

    // Reloading on the next day resets stale counts loaded from disk.
    now = new Date(2026, 10, 27, 8, 0, 0);
    const nextDayReload = new ImageUsageStore(usageFile(), () => now);
    expect(nextDayReload.today()).toEqual({
      date: "2026-11-27",
      total: 0,
      byProject: {},
    });
  });
});
