import type { SessionStatus } from "@codeden/contracts";
import { useRouterState } from "@tanstack/react-router";
import { statusTone, type Tone } from "@/lib/format";
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
  tone,
  sessionId,
  className,
}: {
  status?: SessionStatus;
  tone?: Tone;
  /** The session the dot is for: the dot is steady while that session is open. */
  sessionId?: string;
  className?: string;
}) {
  const t = tone ?? (status ? statusTone[status] : "idle");
  const enabled = usePreferencesStore((s) => s.pulseNeedsYou);
  const open = useRouterState({
    select: (s) => (sessionId ? s.location.pathname.includes(`/sessions/${sessionId}`) : false),
  });
  // Only a session's own Needs-you dot pulses; other amber indicators stay steady.
  const pulse = Boolean(sessionId) && t === "waiting" && enabled && !open;
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
