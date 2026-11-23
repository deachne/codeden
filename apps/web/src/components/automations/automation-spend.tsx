import type { AutomationSpend } from "@codeden/contracts";
import { useMemo } from "react";
import { useUsageReport } from "@/components/usage/api";
import { localToday, money, shiftDay } from "@/components/usage/format";

/** The spend window shown next to each automation. */
export const SPEND_DAYS = 30;

/** Plain words for one automation's recent spend and where the figure comes from. */
export function spendText(spend: AutomationSpend | undefined): string {
  if (!spend || spend.costUsd <= 0) return `No spend in the last ${SPEND_DAYS} days`;
  const window = `in the last ${SPEND_DAYS} days`;
  if (spend.estimatedCostUsd <= 0)
    return `${money(spend.costUsd)} ${window} (reported by the provider)`;
  if (spend.estimatedCostUsd >= spend.costUsd)
    return `${money(spend.costUsd, true)} ${window} (estimated by CodeDen)`;
  return `${money(spend.costUsd, true)} ${window} (partly estimated)`;
}

/** One usage report for the last 30 days, indexed by automation id (a single request for a whole list). */
export function useAutomationSpend(): { byId: Map<string, AutomationSpend>; ready: boolean } {
  const query = useMemo(() => {
    const to = localToday();
    return { from: shiftDay(to, -(SPEND_DAYS - 1)), to };
  }, []);
  const report = useUsageReport(query);
  const list = report.data?.automations.byAutomation;
  return useMemo(
    () => ({ byId: new Map((list ?? []).map((s) => [s.automationId, s])), ready: Boolean(list) }),
    [list],
  );
}

export function AutomationSpendText({ spend }: { spend: AutomationSpend | undefined }) {
  return <span data-testid="automation-spend">{spendText(spend)}</span>;
}
