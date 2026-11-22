import type { Session, SessionStatus } from "@codeden/contracts";
import { useRouterState } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { sessionTone, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";

const toneClass: Record<Tone, string> = {
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  done: "bg-status-done",
  failed: "bg-status-failed",
  idle: "bg-status-idle",
};

/**
 * Session status dot, one colour per state: needs you (amber), working (blue), done (green),
 * failed (red), idle (grey). Only needs-you moves: a slow, subtle pulse that stops once the
 * session is open (handled) or when the setting is off.
 */
export function StatusDot({
  status,
  lastTurn,
  tone,
  sessionId,
  className,
}: {
  status?: SessionStatus;
  /** How the session's last turn ended: tells a finished idle session from one that never ran. */
  lastTurn?: Session["lastTurnStatus"];
  tone?: Tone;
  /** The session the dot is for: the dot is steady while that session is open. */
  sessionId?: string;
  className?: string;
}) {
  const t = tone ?? (status ? sessionTone(status, lastTurn) : "idle");
  const enabled = usePreferencesStore((s) => s.pulseNeedsYou);
  const open = useRouterState({
    select: (s) => (sessionId ? s.location.pathname.includes(`/sessions/${sessionId}`) : false),
  });
  // Only a session's own Needs-you dot pulses; other amber indicators stay steady.
  const pulse = Boolean(sessionId) && t === "waiting" && enabled && !open;
  // An idle session whose last job finished shows a green check, the size of a dot, with a label.
  if (status === "idle" && lastTurn === "completed") {
    return (
      <span
        role="img"
        aria-label="Done"
        title="Done"
        className={cn("relative inline-flex size-3 shrink-0", className)}
      >
        <Check strokeWidth={3.5} className="size-3 text-status-done" aria-hidden />
      </span>
    );
  }
  return (
    <span className={cn("relative inline-flex size-3 shrink-0", className)} aria-hidden>
      <span
        data-pulse={pulse ? "true" : undefined}
        className={cn(
          "relative inline-block size-3 rounded-full",
          toneClass[t],
          pulse && "motion-safe:animate-needs-you",
        )}
      />
    </span>
  );
}
