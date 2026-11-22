import type { Session } from "@codeden/contracts";
import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { sessionOutcome } from "@/lib/session-outcome";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";

/**
 * The top of a finished agent's output: a green Done or red Failed banner (Failed with a
 * one-line reason), and a plain two-line summary with whether the owner has to act.
 * Done clears the next time the session is opened; Failed stays while the session is failed.
 */
export function OutcomeBanner({ session }: { session: Session }) {
  const outcome = sessionOutcome(session);
  const marker = session.endedAt ?? session.updatedAt;
  const markDoneSeen = usePreferencesStore((s) => s.markDoneSeen);
  // Decided once when the session opens, so Done shows while open and is gone the next time.
  const [alreadySeen] = useState(
    () => usePreferencesStore.getState().seenDone[session.id] === marker,
  );
  const isDone = outcome?.kind === "done";
  useEffect(() => {
    if (isDone) markDoneSeen(session.id, marker);
  }, [isDone, markDoneSeen, session.id, marker]);

  if (!outcome || (isDone && alreadySeen)) return null;
  const failed = outcome.kind === "failed";
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
            : "border-status-done/40 bg-status-done/10",
        )}
      >
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
        <div className="mt-1.5 text-[13px] text-foreground/90">
          {outcome.summary && <p className="line-clamp-2">{outcome.summary}</p>}
          <p className="mt-0.5 text-muted-foreground">Do you need to act? {outcome.action}</p>
        </div>
      </div>
    </div>
  );
}
