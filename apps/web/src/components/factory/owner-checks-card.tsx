import {
  OWNER_CHECK_MAX,
  type OwnerCheck,
  type OwnerCheckRun,
  type OwnerCheckRunRequest,
} from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, Pencil, Play, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

/**
 * Owner checks (§10.1): short scenarios the owner writes in plain words. CodeDen keeps them in its
 * own data folder; builders and reviewers never see them. A separate tryout agent uses the running
 * app against them before a factory merge, and each keeps its last result here: the owner's list
 * of what is proven to work.
 */

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "last passed 18 Nov on #12" / "last failed 18 Nov" / "not tried yet". */
export function lastResultText(check: Pick<OwnerCheck, "last">): string {
  const last = check.last;
  if (!last) return "not tried yet";
  const day = DAY.format(new Date(last.at));
  return `last ${last.state === "pass" ? "passed" : "failed"} ${day}${last.prNumber !== null ? ` on #${last.prNumber}` : ""}`;
}

export function useOwnerChecks(projectId: string) {
  const client = useClient();
  return useQuery({
    queryKey: factoryKeys.ownerChecks(projectId),
    queryFn: () => client.factory.ownerChecks(projectId),
  });
}

function useRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: factoryKeys.ownerChecks(projectId) });
}

export function OwnerChecksCard({ projectId }: { projectId: string }) {
  const client = useClient();
  const refresh = useRefresh(projectId);
  const { data } = useOwnerChecks(projectId);
  const [draft, setDraft] = useState("");
  const add = useMutation({
    mutationFn: (text: string) => client.factory.addOwnerCheck(projectId, text),
    onSuccess: () => {
      setDraft("");
      refresh();
    },
    onError: (e: Error) => toast.error("Couldn't add the owner check", { description: e.message }),
  });
  const checks = data?.checks ?? [];
  const latest = data?.runs[0];
  return (
    <details
      className="group rounded-lg border border-border bg-surface text-2xs"
      data-testid="owner-checks"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-medium text-muted-foreground">
        <ClipboardCheck className="size-3.5" aria-hidden />
        Owner checks
        <span className="font-normal text-muted-foreground/80">
          · what the app must do, tried in the running app before a merge; builders and reviewers
          never see these
        </span>
        <span className="ml-auto tabular-nums">{checks.length}</span>
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        {data && !data.devServer && (
          <p className="rounded-md bg-status-waiting/10 px-2 py-1.5 text-3xs text-status-waiting">
            Set a <code>devServer</code> in <code>.codeden/project.json</code> so the app can be
            started: until then the owner checks are skipped.
          </p>
        )}
        {checks.length === 0 ? (
          <p className="px-2 py-2 text-center text-3xs text-muted-foreground/70">
            None yet. Write what the app must do in plain words, for example "I paste a YouTube link
            and get a condensed version with timestamps".
          </p>
        ) : (
          <ol className="space-y-0.5">
            {checks.map((c, n) => (
              <OwnerCheckRow key={c.id} projectId={projectId} check={c} number={n + 1} />
            ))}
          </ol>
        )}
        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) add.mutate(draft.trim());
          }}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={OWNER_CHECK_MAX}
            rows={2}
            placeholder="I paste a YouTube link and get a condensed version with timestamps"
            aria-label="New owner check"
            className="min-h-0 text-xs"
          />
          <Button type="submit" size="sm" disabled={!draft.trim() || add.isPending}>
            <Plus className="size-3.5" /> Add
          </Button>
        </form>
        {latest && <RunLine run={latest} />}
      </div>
    </details>
  );
}

function OwnerCheckRow({
  projectId,
  check,
  number,
}: {
  projectId: string;
  check: OwnerCheck;
  number: number;
}) {
  const client = useClient();
  const refresh = useRefresh(projectId);
  const [editing, setEditing] = useState<string | null>(null);
  const edit = useMutation({
    mutationFn: (text: string) => client.factory.editOwnerCheck(projectId, check.id, text),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError: (e: Error) => toast.error("Couldn't save the owner check", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => client.factory.removeOwnerCheck(projectId, check.id),
    onSuccess: refresh,
    onError: (e: Error) =>
      toast.error("Couldn't remove the owner check", { description: e.message }),
  });
  const state = check.last?.state;
  return (
    <li
      className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
      data-testid="owner-check"
    >
      <span className="w-4 shrink-0 pt-0.5 text-right tabular-nums text-muted-foreground">
        {number}.
      </span>
      <span className="min-w-0 flex-1">
        {editing !== null ? (
          <form
            className="flex items-start gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (editing.trim()) edit.mutate(editing.trim());
            }}
          >
            <Textarea
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              maxLength={OWNER_CHECK_MAX}
              rows={2}
              aria-label={`Owner check ${number}`}
              className="min-h-0 text-xs"
            />
            <Button type="submit" size="icon-xs" aria-label="Save" disabled={edit.isPending}>
              <Check className="size-3.5" />
            </Button>
          </form>
        ) : (
          <span className="block text-[12.5px] leading-snug text-foreground/90">{check.text}</span>
        )}
        <span
          className={
            state === "pass"
              ? "block text-3xs text-status-done"
              : state === "fail"
                ? "block text-3xs text-status-failed"
                : "block text-3xs text-muted-foreground/80"
          }
          data-testid="owner-check-last"
        >
          {lastResultText(check)}
          {check.last?.observation && (
            <span className="text-muted-foreground/80"> · {check.last.observation}</span>
          )}
          {check.last?.screenshot && /^https?:\/\//.test(check.last.screenshot) && (
            <>
              {" · "}
              <a
                href={check.last.screenshot}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                screenshot
              </a>
            </>
          )}
        </span>
      </span>
      {editing === null && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          aria-label={`Edit owner check ${number}`}
          onClick={() => setEditing(check.text)}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label={`Remove owner check ${number}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

const RUN_STATE: Record<OwnerCheckRun["state"], string> = {
  running: "running",
  passed: "all passed",
  failed: "some failed",
  error: "couldn't finish",
};

/** The latest run, in one line. */
function RunLine({ run }: { run: OwnerCheckRun }) {
  const failed = run.results.filter((r) => r.state === "fail").length;
  return (
    <p className="px-2 text-3xs text-muted-foreground" data-testid="owner-checks-run">
      Last run {DAY.format(new Date(run.startedAt))}
      {run.prNumber !== null && ` on #${run.prNumber}`}: {RUN_STATE[run.state]}
      {run.state === "failed" && ` (${failed} of ${run.results.length})`}
      {run.detail && ` · ${run.detail}`}
    </p>
  );
}

/**
 * "Run owner checks" on a session's branch or a work item's PR: the same tryout as before a
 * factory merge. Hidden when the project has no owner checks.
 */
export function RunOwnerChecksButton({
  projectId,
  target,
}: {
  projectId: string;
  target: OwnerCheckRunRequest;
}) {
  const client = useClient();
  const refresh = useRefresh(projectId);
  const { data } = useOwnerChecks(projectId);
  const run = useMutation({
    mutationFn: () => client.factory.runOwnerChecks(projectId, target),
    onSuccess: (r) => {
      refresh();
      if (r.state === "error") {
        toast.error("The owner checks didn't start", { description: r.detail ?? undefined });
      } else {
        toast.success("Owner checks started", {
          description: "A tryout agent is using the app; results show under Owner checks.",
        });
      }
    },
    onError: (e: Error) => toast.error("Couldn't run the owner checks", { description: e.message }),
  });
  if (!data || data.checks.length === 0) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={run.isPending || !data.devServer}
      title={
        data.devServer
          ? "A separate agent starts the app and tries your owner checks in the browser"
          : "Set a devServer in .codeden/project.json first"
      }
      onClick={() => run.mutate()}
      data-testid="run-owner-checks"
    >
      <Play className="size-3.5" /> Run owner checks
    </Button>
  );
}
