import type { BuilderScore, BuilderScoreRow, ScorecardDays } from "@codeden/contracts";
import { type ReactNode, useState } from "react";
import { Segmented } from "@/components/automations/form-bits";
import { ProviderMark } from "@/components/common/bits";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useBuilderScore } from "./api";
import {
  costPerChange,
  costPerChangeTitle,
  passedFirstTime,
  reviewRounds,
  tooFewText,
} from "./builder-score";
import { PROVIDER_NAMES } from "./format";

const WINDOWS: Array<{ id: `${ScorecardDays}`; label: string }> = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

/** Column headings, each with what it counts on hover. */
const COLUMNS: Array<{ label: string; title: string }> = [
  { label: "Changes finished", title: "Changes that were merged or failed on their own work" },
  {
    label: "Passed review first time",
    title: "Merged with no revise round and not reverted, as a share of the finished changes",
  },
  { label: "Review rounds", title: "Revise rounds per finished change" },
  { label: "Reverted", title: "Merged changes taken back because checks failed after them" },
  {
    label: "Cost per merged change",
    title: "What the finished changes cost, failed ones included, per merged change",
  },
  {
    label: "In progress",
    title: "Changes this builder has under way now: not counted as failures",
  },
];

/**
 * How each builder model does on the factory's real work (§12.6), from the factory's own reviews
 * across every project (or the one this page is filtered to), with a window of its own.
 */
export function BuilderScoreTable({ projectId }: { projectId?: string }) {
  const [days, setDays] = useState<ScorecardDays>(30);
  const { data, error } = useBuilderScore(days, projectId);
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const name = (id: string) =>
    providers.find((p) => p.id === id)?.displayName ?? PROVIDER_NAMES[id] ?? id;

  return (
    <div className="space-y-2" data-testid="builder-score">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Window"
          value={`${days}` as const}
          options={WINDOWS}
          onChange={(v) => setDays(Number(v) as ScorecardDays)}
        />
        <p className="text-xs text-muted-foreground">
          Taken from the factory's own reviews of your real work.
        </p>
      </div>
      {error ? (
        <p className="py-4 text-center text-xs text-status-failed">
          Couldn't load the builder score: {error.message}
        </p>
      ) : !data || data.days !== days ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : data.rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-card py-6 text-center text-xs text-muted-foreground">
          No factory work from a builder in the last {days} days.
        </p>
      ) : (
        <BuilderRows score={data} name={name} />
      )}
    </div>
  );
}

function BuilderRows({ score, name }: { score: BuilderScore; name: (id: string) => string }) {
  const apiEquivalent = score.rows.some((r) => r.apiEquivalent);
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-border bg-card px-2">
        <Table className="text-xs" data-testid="builder-score-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 text-2xs">Builder</TableHead>
              {COLUMNS.map((c) => (
                <TableHead key={c.label} className="h-8 text-right text-2xs" title={c.title}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {score.rows.map((r) => (
              <BuilderRow key={r.key} row={r} minChanges={score.minChanges} name={name} />
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="px-1 text-2xs text-muted-foreground">
        Each change counts for the builder of its last attempt. Dismissed or escalated work, setup
        failures and the factory's own reverts don't count. Costs include every agent that worked on
        the change
        {apiEquivalent
          ? " and are API-equivalent: what the same work would cost on API credits"
          : ""}
        ; "Not priced" means CodeDen had no price for that work, so it is not shown as $0.00.
      </p>
    </div>
  );
}

function BuilderRow(props: {
  row: BuilderScoreRow;
  minChanges: number;
  name: (id: string) => string;
}) {
  const { row, minChanges, name } = props;
  return (
    <TableRow data-testid="builder-score-row">
      <TableCell className="max-w-72 py-1.5">
        <span
          className="inline-flex min-w-0 items-center gap-1.5"
          title={`${name(row.provider)} · ${row.model ?? "default model"}`}
        >
          <ProviderMark provider={row.provider} className="size-3.5 text-[8px]" />
          <span className="font-medium">{name(row.provider)}</span>
          <span className="truncate font-mono text-2xs text-muted-foreground">
            {row.model ?? "default model"}
          </span>
        </span>
      </TableCell>
      <Num>
        {row.finished}
        {row.tooFew && (
          <span
            className="ml-1.5 text-2xs text-muted-foreground"
            title={tooFewText(row, minChanges)}
          >
            Too few to judge
          </span>
        )}
      </Num>
      <Num title={`${row.firstPass} of ${row.finished} changes`}>{passedFirstTime(row)}</Num>
      <Num title={`${row.reviseRounds} rounds over ${row.finished} changes`}>
        {reviewRounds(row)}
      </Num>
      <Num className={cn(row.reverted > 0 && "text-status-failed")}>{row.reverted}</Num>
      <Num className="font-mono" title={costPerChangeTitle(row)}>
        {costPerChange(row)}
      </Num>
      <Num>{row.inProgress > 0 ? `${row.inProgress} in progress` : "—"}</Num>
    </TableRow>
  );
}

function Num(props: { children: ReactNode; className?: string; title?: string }) {
  return (
    <TableCell
      className={cn("py-1.5 text-right whitespace-nowrap tabular-nums", props.className)}
      title={props.title}
    >
      {props.children}
    </TableCell>
  );
}
