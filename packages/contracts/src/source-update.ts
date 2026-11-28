import { z } from "zod";
import { Timestamp } from "./common";

/**
 * The update script's run: `idle` (never run, or it finished without restarting CodeDen),
 * `running` (started; the server stops when the script restarts it), `failed` (it stopped
 * with an error, see `error`; CodeDen kept running on the old build).
 */
export const SourceUpdateState = z.enum(["idle", "running", "failed"]);
export type SourceUpdateState = z.infer<typeof SourceUpdateState>;

/**
 * `GET /api/updates/source`: the "Update" button for a CodeDen run from a git checkout. The
 * script is `settings.updates.sourceScript` (empty: no button), e.g. one that pulls, rebuilds
 * and restarts. The script path can only be changed from this computer; any signed-in device
 * can start it.
 */
export const SourceUpdateStatus = z.object({
  /** A script path is set in Settings. */
  configured: z.boolean(),
  /** The script path with `~` expanded, or null when none is set. */
  scriptPath: z.string().nullable(),
  /** Why the script can't run (missing, a folder, not executable), else null. */
  problem: z.string().nullable(),
  /** New commits on the checkout's upstream branch; null when unknown (not a git checkout, offline). */
  behind: z.number().int().nonnegative().nullable(),
  /** When `behind` was last checked. */
  checkedAt: Timestamp.nullable(),
  /** Why the last check failed, else null. */
  checkError: z.string().nullable(),
  state: SourceUpdateState,
  /** When the running or last run started. */
  startedAt: Timestamp.nullable(),
  /** Why the last run failed, with the end of its output. */
  error: z.string().nullable(),
  /** Changes every time the server starts: the browser reloads once it sees a new one. */
  bootId: z.string(),
});
export type SourceUpdateStatus = z.infer<typeof SourceUpdateStatus>;
