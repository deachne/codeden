import type { Session } from "@codeden/contracts";
import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect } from "react";
import { sessionOutcome } from "@/lib/session-outcome";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";

/** How long the Done banner stays after the session is opened, in milliseconds. */
export const DONE_BANNER_MS = 4_000;

/**
 * The top of a finished agent's output: a green Done or red Failed banner (Failed with a
 * one-line reason), and a plain two-line summary with whether the owner has to act.
 * Done clears shortly after the session is opened (and stays cleared); Failed stays while the
 * session is failed. The summary stays either way.
 */
export function OutcomeBanner({
  session,
  turnError,
}: {
  session: Session;
  turnError?: string | null;
}) {
  const outcome = sessionOutcome(session, turnError);
  const marker = session.endedAt ?? session.updatedAt;
  const seen = usePreferencesStore((s) => s.seenDone[session.id] === marker);
  const markDoneSeen = usePreferencesStore((s) => s.markDoneSeen);
  const isDone = outcome?.kind === "done";
  useEffect(() => {
    if (!isDone || seen) return;
    const timer = setTimeout(() => markDoneSeen(session.id, marker), DONE_BANNER_MS);
    return () => clearTimeout(timer);
  }, [isDone, seen, markDoneSeen, session.id, marker]);

  if (!outcome) return null;
  const failed = outcome.kind === "failed";
  const showHeader = failed || !seen;
  const Icon = failed ? XCircle : CheckCircle2;
  return (
    <div
      role="status"
      data-outcome={outcome.kind}
      className="mx-auto w-full max-w-[46rem] shrink-0 px-6 pt-4"
    >
      <div
        className={cn(
          "rounded-lg border px-4 py-3",
          failed
            ? "border-status-failed/40 bg-status-failed/10"
            : showHeader
              ? "border-status-done/40 bg-status-done/10"
              : "border-border bg-muted/30",
        )}
      >
        {showHeader && (
          <p
            className={cn(
              "flex items-center gap-2 text-sm font-semibold",
              failed ? "text-status-failed" : "text-status-done",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {failed ? "Failed" : "Done"}
            {failed && outcome.reason && (
              <span className="min-w-0 truncate font-normal text-foreground">{outcome.reason}</span>
            )}
          </p>
        )}
        <div className={cn("text-[13px] text-foreground/90", showHeader && "mt-1.5")}>
          {outcome.summary && <p className="line-clamp-2">{outcome.summary}</p>}
          <p className="mt-0.5 text-muted-foreground">Do you need to act? {outcome.action}</p>
        </div>
      </div>
    </div>
  );
}
