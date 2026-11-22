import type { Session } from "@codeden/contracts";
import { statusTone } from "./format";

const rest: Record<string, number> = { running: 0, starting: 0, queued: 1 };

/** Sort rank: needs-you first, then failed, then the rest in their normal order. */
function rank(status: Session["status"]): number {
  const tone = statusTone[status];
  if (tone === "waiting") return 0;
  if (tone === "failed") return 1;
  return 2 + (rest[status] ?? 2);
}

/** Needs-you sessions first, then failed ones, then the rest (working, queued, newest first). */
export function sortSessionsByAttention(list: readonly Session[]): Session[] {
  return [...list].sort(
    (a, b) => rank(a.status) - rank(b.status) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}
