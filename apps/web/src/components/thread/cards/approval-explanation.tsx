import type { ApprovalExplanation, ApprovalRisk } from "@codeden/contracts";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const riskLabel: Record<ApprovalRisk, string> = {
  green: "Low (green)",
  yellow: "Medium (yellow)",
  red: "High (red)",
};

const riskDot: Record<ApprovalRisk, string> = {
  green: "bg-status-done",
  yellow: "bg-status-waiting",
  red: "bg-status-failed",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 text-[13px] leading-relaxed">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * An approval in plain words (§11.2): what it does, why, whether it can be undone and how risky
 * it is (both CodeDen's own verdict), and advice. The card puts its usual content under Details.
 */
export function ApprovalExplanationRows({ explanation }: { explanation: ApprovalExplanation }) {
  const { whatItDoes, why, undoable, risk, advice } = explanation;
  return (
    <dl className="space-y-1.5" data-testid="approval-explanation">
      <Row label="What it does">
        <span className="font-medium">{whatItDoes}</span>
      </Row>
      <Row label="Why">{why}</Row>
      <Row label="Can it be undone">
        <span className={cn("font-medium", undoable ? "text-status-done" : "text-status-failed")}>
          {undoable ? "Yes" : "No, it can't be undone"}
        </span>
      </Row>
      <Row label="Risk">
        <span className="inline-flex items-center gap-1.5" data-risk={risk}>
          <span className={cn("size-2.5 rounded-full", riskDot[risk])} aria-hidden />
          {riskLabel[risk]}
        </span>
      </Row>
      <Row label="Advice">
        <span className="font-medium">{advice.verdict === "approve" ? "Approve" : "Deny"}</span>
        <span className="text-muted-foreground">: {advice.reason}</span>
      </Row>
    </dl>
  );
}
