import type { Session } from "@codeden/contracts";

/** What the owner sees at a glance for a finished session. */
export interface SessionOutcome {
  kind: "done" | "failed";
  /** One line: why it failed (failed only). */
  reason: string | null;
  /** What happened, in a couple of lines (from the agent's own report), or null. */
  summary: string | null;
  /** Whether the owner has to do anything, in plain words. */
  action: string;
}

const FALLBACK_REASON = "Something went wrong. The details are below.";

/** First line of a text, cut to a short length. */
function oneLine(text: string, max = 140): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The finished-session banner and summary content; null while the session isn't finished. */
export function sessionOutcome(session: Session): SessionOutcome | null {
  const result = session.result ?? null;
  const summary = result ? result.summary.trim() : null;
  if (session.status === "failed") {
    const reason =
      result?.outcome === "failed" && summary
        ? oneLine(summary)
        : session.startError?.message
          ? oneLine(session.startError.message)
          : FALLBACK_REASON;
    return {
      kind: "failed",
      reason,
      summary,
      action:
        result?.nextSteps?.[0] ?? "Yes: it didn't finish. Open the details or ask it to try again.",
    };
  }
  if (session.status !== "completed") return null;
  const next = result?.nextSteps?.filter((n) => n.trim()) ?? [];
  let action = "No, nothing is needed from you.";
  if (next.length > 0) action = `Yes: ${next[0]}`;
  else if (result?.outcome === "blocked") action = "Yes: it is blocked and needs your help.";
  else if (result?.outcome === "partial") action = "Yes: it only got part of the way. Take a look.";
  else if (result?.outcome === "failed") action = "Yes: it reported a problem. Take a look.";
  return { kind: "done", reason: null, summary, action };
}
