import type { FactoryReleaseSnapshot } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The factory panel's release batch card (#4): the merged work waiting on the release branch,
 * what gates its release (CI, then the owner checks), and the one approval that releases the
 * whole batch into the default branch. Hidden while release mode is off (the server then sends
 * no snapshot).
 */
export function ReleaseCard({
  projectId,
  release,
}: {
  projectId: string;
  release: FactoryReleaseSnapshot;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(release.batch.length > 0);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
  const approve = useMutation({
    mutationFn: () => client.factory.releaseApprove(projectId),
    onSuccess: (snapshot) => {
      toast.success(
        snapshot.batch.length === 0
          ? "Batch released"
          : `${snapshot.batch.length} change${snapshot.batch.length === 1 ? "" : "s"} released`,
      );
      refresh();
    },
    onError: (e: Error) => toast.error("Couldn't release", { description: e.message }),
  });
  const n = release.batch.length;
  const released = release.released ?? [];
  const branch = release.branch;
  const ci =
    release.ci === "success"
      ? `CI is green on ${branch}`
      : release.ci === "failure"
        ? `CI is failing on ${branch}`
        : release.ci === "pending"
          ? `CI is still running on ${branch}`
          : release.ci === "none"
            ? `No CI results on ${branch} yet`
            : `CI on ${branch} hasn't been read yet`;
  const gates =
    release.ci === "success" && release.ownerChecks.state === "pass"
      ? `${ci}, the owner checks passed`
      : ci;
  return (
    <details
      className="group rounded-lg border border-border bg-surface text-2xs"
      data-testid="factory-release"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-medium text-muted-foreground">
        <PackageCheck className="size-3.5" aria-hidden />
        Release batch
        <span className="min-w-0 truncate font-normal text-muted-foreground/80">
          · {release.branch}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full px-1.5 tabular-nums",
            release.canRelease && "bg-status-waiting/12 text-status-waiting",
          )}
          title="Merged changes waiting for release"
        >
          {n === 0 ? "empty" : `${n} waiting`}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <p className="px-1 text-3xs text-muted-foreground" data-testid="release-gates">
          {gates}
          {release.headSha && ` (${release.headSha.slice(0, 7)})`}
          {release.ownerChecks.state !== "skipped" &&
            release.ownerChecks.state !== "pass" &&
            ` · owner checks: ${release.ownerChecks.state.replace("_", " ")}`}
          .
        </p>
        {n === 0 ? (
          <p className="py-2 text-center text-3xs text-muted-foreground/70">
            Nothing waiting: merges land here once release mode has work.
          </p>
        ) : (
          <ul className="space-y-1">
            {release.batch.map((b) => (
              <li
                key={b.itemId}
                className="flex items-baseline gap-2 px-2 py-1 text-2xs"
                data-testid="release-batch-item"
              >
                <Link
                  to="/projects/$projectId/factory/$itemId"
                  params={{ projectId, itemId: b.itemId }}
                  className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground/90 hover:underline"
                >
                  {b.title}
                </Link>
                <a
                  href={b.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-muted-foreground tabular-nums hover:underline"
                >
                  #{b.prNumber}
                </a>
                <span
                  className="shrink-0 text-3xs text-muted-foreground/70"
                  title={`Merged ${b.mergedAt}`}
                >
                  {ago(b.mergedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {release.releasedSha && released.length > 0 && (
          <div className="space-y-1 border-t border-border px-1 pt-2">
            <p className="text-3xs font-medium text-muted-foreground">
              Released, watching CI on the default branch ({release.releasedSha.slice(0, 7)})
            </p>
            <ul className="space-y-1">
              {released.map((b) => (
                <li
                  key={b.itemId}
                  className="flex items-baseline gap-2 px-2 py-1 text-2xs"
                  data-testid="release-released-item"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/80">
                    {b.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">#{b.prNumber}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {release.canRelease && n > 0 && (
          <div className="px-1 pt-1">
            <Button
              size="sm"
              onClick={() => approve.mutate()}
              disabled={approve.isPending}
              data-testid="release-approve"
            >
              <PackageCheck /> Release {n} change{n === 1 ? "" : "s"}
            </Button>
          </div>
        )}
        {!release.canRelease && release.blockReason && (
          <p className="px-1 text-3xs text-muted-foreground/80">{release.blockReason}</p>
        )}
      </div>
    </details>
  );
}
