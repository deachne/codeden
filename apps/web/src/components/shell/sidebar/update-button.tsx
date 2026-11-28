import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useRefreshSourceUpdate,
  useResumeSourceRestart,
  useRunSourceUpdate,
  useSourceRestart,
  useSourceUpdate,
} from "@/lib/source-update";

function changes(n: number): string {
  return n === 1 ? "1 new change" : `${n} new changes`;
}

/**
 * The sidebar header's Update button, shown only when an update script is set (Settings >
 * General > Update script). Asks first, runs the script, then waits for CodeDen to come back
 * and reloads the page. A dot means GitHub has changes this copy doesn't.
 */
export function UpdateButton() {
  const { data: status } = useSourceUpdate();
  const run = useRunSourceUpdate();
  const restart = useSourceRestart();
  const refresh = useRefreshSourceUpdate();
  const [open, setOpen] = useState(false);
  useResumeSourceRestart(status);

  if (!status?.configured) return null;

  const busy = restart.phase === "waiting" || restart.phase === "slow" || run.isPending;
  const failed = restart.phase === "failed" || status.state === "failed";
  const error = run.error?.message ?? (failed ? (restart.error ?? status.error) : null);
  const behind = status.behind ?? 0;

  const tip = busy
    ? "Updating CodeDen…"
    : status.problem
      ? "Update script not found"
      : failed
        ? "The last update failed"
        : behind > 0
          ? `Update CodeDen · ${changes(behind)}`
          : "Update CodeDen";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative text-muted-foreground"
            onClick={() => {
              setOpen(true);
              refresh.mutate();
            }}
            disabled={busy}
            aria-label={tip}
            data-testid="source-update-button"
          >
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : failed || status.problem ? (
              <AlertTriangle className="text-status-failed" />
            ) : (
              <RefreshCw />
            )}
            {!busy && !failed && !status.problem && behind > 0 && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-status-running" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update CodeDen?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {status.problem ? (
                  <p>
                    {status.problem} Check the path in Settings &gt; General &gt; Update script.
                  </p>
                ) : (
                  <>
                    <p>
                      {refresh.isPending
                        ? "Checking GitHub for new changes…"
                        : status.behind === null
                          ? "Couldn't check GitHub for new changes."
                          : behind > 0
                            ? `GitHub has ${changes(behind)} this copy doesn't have yet.`
                            : "You're already up to date. Updating again just rebuilds and restarts."}
                    </p>
                    <p>
                      This gets the latest from GitHub, rebuilds (a few minutes) and restarts
                      CodeDen. Running agents pause and pick up again. This page reloads by itself
                      when CodeDen is back.
                    </p>
                  </>
                )}
                {error && (
                  <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-left text-2xs whitespace-pre-wrap">
                    {error}
                  </pre>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {!status.problem && (
              <AlertDialogAction
                onClick={() => {
                  useSourceRestart.getState().set("idle");
                  run.reset();
                  run.mutate();
                }}
              >
                Update now
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {busy && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-md"
        >
          <Loader2 className="size-4 animate-spin text-status-running" />
          {restart.phase === "slow"
            ? "Still updating. This is taking longer than usual."
            : "Updating CodeDen… this page reloads when it's back."}
        </div>
      )}
    </>
  );
}
