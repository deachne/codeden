import type { AutomationRun } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";

/**
 * Yes and No for a recipe's "ask me" step (§10): Yes carries the recipe on to its next step,
 * No stops it here. The inbox card and the run view both use it.
 */
export function RecipeAnswerButtons({
  itemId,
  onAnswered,
}: {
  itemId: string;
  onAnswered?: (run: AutomationRun) => void;
}) {
  const client = useClient();
  const answer = useMutation({
    mutationFn: (value: "yes" | "no") => client.automations.answerRecipe(itemId, value),
    onSuccess: (res, value) => {
      toast.success(value === "yes" ? "Carrying on" : "The recipe stopped");
      onAnswered?.(res.run);
    },
    onError: (e: Error) => toast.error("Couldn't send your answer", { description: e.message }),
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="recipe-answer">
      <Button size="sm" onClick={() => answer.mutate("yes")} disabled={answer.isPending}>
        <Check /> Yes, carry on
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => answer.mutate("no")}
        disabled={answer.isPending}
      >
        <X /> No, stop here
      </Button>
    </div>
  );
}
