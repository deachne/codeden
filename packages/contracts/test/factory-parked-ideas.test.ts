import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  ideasIssueBody,
  ParkedIdea,
  ParkIdeaRequest,
  parkedIdeaKey,
  parkedIdeaShown,
  Settings,
} from "../src";

const idea = ParkedIdea.parse({
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  title: "Show what each agent run cost",
  key: parkedIdeaKey("Show what each agent run cost"),
  whyLiked: "You see which jobs are expensive.",
  whyParked: "Smaller than the three picked.",
  status: "parked",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
});

describe("parked ideas", () => {
  it("round-trips through its event and fills defaults", () => {
    expect(idea.details).toBeNull();
    expect(idea.ideasIssue).toBeNull();
    expect(idea.pendingLabels).toEqual([]);
    const event = EventEnvelope.parse({
      seq: 1,
      ts: "2026-11-01T10:00:00.000Z",
      type: "factory.parked_idea.updated",
      sessionId: null,
      payload: { idea },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("requires both reasons from the scout", () => {
    const ok = { title: "T", whyLiked: "a", whyParked: "b" };
    expect(ParkIdeaRequest.safeParse(ok).success).toBe(true);
    expect(ParkIdeaRequest.safeParse({ ...ok, whyParked: "  " }).success).toBe(false);
    expect(ParkIdeaRequest.safeParse({ ...ok, whyLiked: undefined }).success).toBe(false);
  });

  it("treats the same title the same way whatever the case or end punctuation", () => {
    expect(parkedIdeaKey("  Warn me  early. ")).toBe(parkedIdeaKey("warn me early"));
  });

  it("shows only parked ideas younger than 60 days", () => {
    const at = (days: number) => new Date(Date.parse(idea.createdAt) + days * 86_400_000);
    expect(parkedIdeaShown(idea, at(59))).toBe(true);
    expect(parkedIdeaShown(idea, at(61))).toBe(false);
    expect(parkedIdeaShown({ ...idea, status: "not_now" }, at(1))).toBe(false);
    expect(parkedIdeaShown({ ...idea, status: "building" }, at(1))).toBe(false);
  });

  it("writes the Ideas issue with the date first and both reasons", () => {
    const body = ideasIssueBody(idea);
    expect(body.split("\n")[0]).toBe("Parked 2026-11-01");
    expect(body).toContain("Why the scout liked it");
    expect(body).toContain("Why it's parked");
  });

  it("defaults the Ideas repository setting", () => {
    expect(Settings.parse({}).factory.ideasRepo).toBe("deachne/ideas");
  });
});
