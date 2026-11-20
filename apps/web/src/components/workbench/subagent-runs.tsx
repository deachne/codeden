import type { BillingMode, Session } from "@codeden/contracts";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useSessionUsage } from "@/components/usage/api";
import { money, subagentCostLines, subagentCostText, tokens } from "@/components/usage/format";
import { plural, subagentStatsParts, subagentStatsTitle } from "@/lib/format";
import { type SubagentRun, type SubagentRunsSummary, subagentRuns } from "@/lib/subagent-runs";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useTranscriptsStore } from "@/stores/transcripts";

/** The section's heading figures: "3 runs · ≈ $0.42 · 120k tokens · 1 running". */
export function subagentRunsHeadline(s: SubagentRunsSummary): string {
  const priced = s.costUsd + s.notLoaded.costUsd;
  const parts = [plural(s.runs.length + s.notLoaded.runs, "run")];
  const anyPriced =
    s.notLoaded.runs > 0 || s.runs.some((r) => r.cost && r.cost.costSource !== "unpriced");
  if (anyPriced) parts.push(money(priced, s.estimated));
  if (s.totalTokens > 0) parts.push(`${tokens(s.totalTokens)} tokens`);
  if (s.running > 0) parts.push(`${s.running} running`);
  return parts.join(" · ");
}

function headlineTitle(s: SubagentRunsSummary, billing: BillingMode): string {
  const kind = billing === "subscription" ? "API-equivalent cost" : "Cost";
  return [
    `${kind} of the subagent runs${s.estimated ? " (estimated from list prices)" : ""}.`,
    s.unpriced > 0 ? `${plural(s.unpriced, "finished run")} not priced.` : "",
    "Already counted in the session's turns, so never added to its total.",
  ]
    .filter(Boolean)
    .join("\n");
}

function RunRow({
  run,
  billing,
  onOpen,
}: {
  run: SubagentRun;
  billing: BillingMode;
  onOpen: () => void;
}) {
  const running = run.status === "in_progress";
  const failed = run.status === "failed";
  const costText = running ? null : subagentCostText(run.cost);
  const figures = running
    ? []
    : [...(costText ? [costText] : []), ...subagentStatsParts(run.stats)];
  const title = [
    run.description,
    ...subagentCostLines(run.cost, billing),
    subagentStatsTitle(run.stats),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={title}
        data-testid="subagent-run"
        style={{ paddingLeft: `${0.375 + run.depth * 0.875}rem` }}
        className="flex w-full items-start gap-2 rounded-md py-1.5 pr-1.5 text-left text-[13px] hover:bg-muted/60"
      >
        {running ? (
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-status-running" />
        ) : failed ? (
          <XCircle className="mt-0.5 size-3.5 shrink-0 text-status-failed" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-status-done" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate">{run.description}</span>
            {run.agentType && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-3xs text-muted-foreground">
                {run.agentType}
              </span>
            )}
          </span>
          <span
            className={cn(
              "block truncate text-2xs text-muted-foreground tabular-nums",
              running && "text-shine",
            )}
          >
            {running
              ? "Running"
              : figures.length > 0
                ? figures.join(" · ")
                : failed
                  ? "Failed"
                  : "Finished"}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Every subagent run of the session with its status, cost, tokens and time (§7.3), from the
 * loaded transcript and the session's usage. Display only: never added to the session's cost.
 * Renders nothing for a session without subagent runs.
 */
export function SubagentRuns({ session }: { session: Session }) {
  const transcript = useTranscriptsStore((s) => s.byId[session.id]);
  const { data } = useSessionUsage(session.id);
  const openChild = useLayoutStore((s) => s.openChildThread);
  const summary = subagentRuns(transcript, data?.subagents ?? []);
  if (summary.runs.length === 0 && summary.notLoaded.runs === 0) return null;
  const billing = data?.billing ?? "unknown";

  return (
    <section className="space-y-2" data-testid="subagent-runs">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
          Subagent runs
        </h3>
        <span
          className="truncate text-2xs text-muted-foreground tabular-nums"
          title={headlineTitle(summary, billing)}
          data-testid="subagent-runs-headline"
        >
          {subagentRunsHeadline(summary)}
        </span>
      </div>
      {summary.runs.length > 0 && (
        <ul className="-mx-1.5">
          {summary.runs.map((run) => (
            <RunRow
              key={run.itemId}
              run={run}
              billing={billing}
              onOpen={() => openChild(session.id, run.childThreadId)}
            />
          ))}
        </ul>
      )}
      {summary.notLoaded.runs > 0 && (
        <p className="text-2xs text-muted-foreground/80" data-testid="subagent-runs-not-loaded">
          {plural(summary.notLoaded.runs, "earlier run")} in turns not loaded here (
          {money(summary.notLoaded.costUsd, summary.estimated)})
        </p>
      )}
    </section>
  );
}
