import type { ReviewerQuality, ReviewerQualityRow } from "@codeden/contracts";
import { ProviderMark } from "@/components/common/bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  costPerReview,
  costPerReviewTitle,
  noVerdictRate,
  noVerdictTitle,
  problemsLater,
  problemsLaterTitle,
  tooFewText,
  unlinkedText,
  unreviewedLabel,
} from "./reviewer-quality";
import type { ProviderNames } from "./scorecard";

const COLUMNS: Array<{ label: string; title: string }> = [
  { label: "Reviews", title: "Reviews that finished in the window, including ones that failed" },
  {
    label: "No verdict",
    title: "Reviews that ended without approving or sending the work back, and their share",
  },
  {
    label: "Problems found later",
    title:
      "Approved changes that had a bug filed against them afterwards (by the scout, an area reviewer or a person)",
  },
  { label: "Cost / review", title: "What the review step cost, per review" },
];

/**
 * The reviewer check (§10.1): is each reviewer model catching problems or letting them through?
 * Per model: reviews that ended with no verdict, bugs found later in what it approved, and cost
 * per review; then the bugs that couldn't be linked, and merges that had no real review.
 */
export function ReviewerCheck(props: { quality: ReviewerQuality; names: ProviderNames }) {
  const { quality, names } = props;
  const unlinked = unlinkedText(quality);
  return (
    <section className="space-y-1.5" data-testid="factory-reviewer-check">
      <h4 className="px-1 text-2xs font-medium text-muted-foreground">
        Is the reviewer doing well?
      </h4>
      {quality.rows.length === 0 ? (
        <p className="py-2 text-center text-3xs text-muted-foreground/70">
          No reviews in this window.
        </p>
      ) : (
        <Table className="text-xs" data-testid="factory-reviewer-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 text-2xs">Reviewer</TableHead>
              {COLUMNS.map((c) => (
                <TableHead key={c.label} className="h-8 text-right text-2xs" title={c.title}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {quality.rows.map((r) => (
              <ReviewerRow key={r.key} row={r} minReviews={quality.minReviews} names={names} />
            ))}
          </TableBody>
        </Table>
      )}
      {unlinked && (
        <p className="px-1 text-3xs text-muted-foreground" data-testid="factory-unlinked-bugs">
          Unlinked: {unlinked}
        </p>
      )}
      <div className="px-1 text-3xs" data-testid="factory-unreviewed-merges">
        <span className="text-muted-foreground">Merged without a real review: </span>
        {quality.unreviewedMerges.length === 0 ? (
          <span className="text-muted-foreground/80">none</span>
        ) : (
          <>
            <span className="font-medium text-status-failed">
              {quality.unreviewedMerges.length}
            </span>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
              {quality.unreviewedMerges.map((m) => (
                <li key={m.itemId}>{unreviewedLabel(m)}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <p className="px-1 text-3xs text-muted-foreground/80">
        Worked out from what the factory had already recorded, so older work that didn't record
        these details isn't counted. A bug only counts against a reviewer when it names the change
        it came from; the factory doesn't guess.
      </p>
    </section>
  );
}

function ReviewerRow(props: { row: ReviewerQualityRow; minReviews: number; names: ProviderNames }) {
  const { row, minReviews, names } = props;
  const reviewer = row.reviewer;
  return (
    <TableRow data-testid="factory-reviewer-row">
      <TableCell className="max-w-80 py-1.5">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ProviderMark provider={reviewer.provider} className="size-3.5 text-[8px]" />
          <span className="font-medium">{names(reviewer.provider)}</span>
          <span className="truncate font-mono text-2xs text-muted-foreground">
            {reviewer.model ?? "default model"}
          </span>
        </span>
      </TableCell>
      <Num>{row.reviews}</Num>
      {/* Too few reviews: the plain count, never a percentage. */}
      <Num className={cn(row.noVerdict > 0 && "text-status-failed")} title={noVerdictTitle(row)}>
        {row.noVerdict}
        {!row.tooFew && (
          <span className="ml-1 text-2xs text-muted-foreground">{noVerdictRate(row)}</span>
        )}
      </Num>
      {row.tooFew ? (
        <TableCell
          className="py-1.5 text-right text-2xs text-muted-foreground"
          title={tooFewText(row, minReviews)}
        >
          Too few to judge
        </TableCell>
      ) : (
        <Num
          className={cn(row.approvalsWithProblems > 0 && "text-status-failed")}
          title={problemsLaterTitle(row)}
        >
          {problemsLater(row)}
        </Num>
      )}
      <Num className="font-mono" title={costPerReviewTitle(row)}>
        {costPerReview(row)}
      </Num>
    </TableRow>
  );
}

function Num(props: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <TableCell
      className={cn("py-1.5 text-right whitespace-nowrap tabular-nums", props.className)}
      title={props.title}
    >
      {props.children}
    </TableCell>
  );
}
