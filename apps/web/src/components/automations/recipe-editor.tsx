import { type AutonomyLevel, RECIPE_MAX_STEPS, type RecipeStep } from "@codeden/contracts";
import { ArrowDown, ArrowUp, Bot, HelpCircle, MessageSquare, Plus, Trash2 } from "lucide-react";
import { supportsReadOnly } from "@/components/thread/autonomy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AgentPicker, useSessionProvider } from "./action-editor";
import { Field } from "./form-bits";
import { PermissionsField } from "./permissions-field";

type SessionStep = Extract<RecipeStep, { type: "start_session" }>;

/** The words a person sees for each kind of step. */
export const STEP_KIND: Record<
  RecipeStep["type"],
  { label: string; hint: string; icon: typeof Bot }
> = {
  start_session: {
    label: "Start an agent session",
    hint: "An agent does a job from your instructions.",
    icon: Bot,
  },
  message_pm: {
    label: "Tell the PM",
    hint: "Sends a message to the project's PM.",
    icon: MessageSquare,
  },
  ask_owner: {
    label: "Pause and ask me",
    hint: "Stops here until you answer Yes or No. Yes carries on, No stops the recipe.",
    icon: HelpCircle,
  },
};

/** A step id nobody uses yet: `step-1`, `step-2`, ... */
export function nextStepId(steps: readonly RecipeStep[]): string {
  const used = new Set(steps.map((s) => s.id));
  for (let n = steps.length + 1; ; n++) if (!used.has(`step-${n}`)) return `step-${n}`;
}

/** A new, empty step of a kind. */
export function newStep(
  type: RecipeStep["type"],
  steps: readonly RecipeStep[],
  autonomy: AutonomyLevel,
): RecipeStep {
  const id = nextStepId(steps);
  if (type === "start_session") return { id, type, prompt: "", autonomy };
  if (type === "message_pm") return { id, type, message: "" };
  return { id, type, question: "OK to go on?" };
}

/** The text a step needs filled in, whatever its kind. */
export function stepText(step: RecipeStep): string {
  if (step.type === "start_session") return step.prompt;
  if (step.type === "message_pm") return step.message;
  return step.question;
}

function SessionStepFields({
  step,
  onChange,
  disabled,
  defaultAutonomy,
}: {
  step: SessionStep;
  onChange: (s: SessionStep) => void;
  disabled?: boolean;
  defaultAutonomy: AutonomyLevel;
}) {
  const { provider } = useSessionProvider(step);
  return (
    <div className="space-y-3">
      <Field label="What should the agent do?">
        <Textarea
          value={step.prompt}
          disabled={disabled}
          rows={4}
          placeholder="Say what done looks like."
          aria-label="Instructions for the agent"
          onChange={(e) => onChange({ ...step, prompt: e.target.value })}
          className="text-[13px]"
        />
      </Field>
      <Field label="Agent">
        <AgentPicker
          action={step}
          disabled={disabled}
          onChange={(next) => onChange({ ...step, ...next })}
        />
      </Field>
      <Field label="Permissions">
        <PermissionsField
          value={step.autonomy ?? defaultAutonomy}
          onChange={(autonomy) => onChange({ ...step, autonomy })}
          disabled={disabled}
          readOnlySupported={supportsReadOnly(provider)}
        />
      </Field>
    </div>
  );
}

/** One step's editor: its kind, its fields, and move and remove. */
function StepCard({
  step,
  index,
  total,
  onChange,
  onMove,
  onRemove,
  disabled,
  defaultAutonomy,
}: {
  step: RecipeStep;
  index: number;
  total: number;
  onChange: (s: RecipeStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  disabled?: boolean;
  defaultAutonomy: AutonomyLevel;
}) {
  const kind = STEP_KIND[step.type];
  const Icon = kind.icon;
  return (
    <li
      className="rounded-lg border border-border bg-surface"
      data-testid="recipe-step"
      data-kind={step.type}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="flex size-5 items-center justify-center rounded-full bg-accent text-3xs font-semibold">
          {index + 1}
        </span>
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{kind.label}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move step ${index + 1} up`}
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move step ${index + 1} down`}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove step ${index + 1}`}
            disabled={disabled || total === 1}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </span>
      </div>
      <div className="p-3">
        {step.type === "start_session" && (
          <SessionStepFields
            step={step}
            onChange={onChange}
            disabled={disabled}
            defaultAutonomy={defaultAutonomy}
          />
        )}
        {step.type === "message_pm" && (
          <Field label="Message to the PM">
            <Textarea
              value={step.message}
              disabled={disabled}
              rows={3}
              aria-label="Message to the PM"
              onChange={(e) => onChange({ ...step, message: e.target.value })}
              className="text-[13px]"
            />
          </Field>
        )}
        {step.type === "ask_owner" && (
          <Field label="What should it ask you?" help={kind.hint}>
            <Input
              value={step.question}
              disabled={disabled}
              aria-label="Question to ask you"
              placeholder="OK to go on?"
              onChange={(e) => onChange({ ...step, question: e.target.value })}
              className="text-[13px]"
            />
          </Field>
        )}
      </div>
    </li>
  );
}

/**
 * The recipe editor (§10): a numbered list of steps CodeDen runs in order. Each step starts an
 * agent session, tells the PM, or pauses and asks you; add, reorder and remove them here.
 */
export function RecipeEditor({
  steps,
  onChange,
  disabled,
  defaultAutonomy,
}: {
  steps: RecipeStep[];
  onChange: (steps: RecipeStep[]) => void;
  disabled?: boolean;
  defaultAutonomy: AutonomyLevel;
}) {
  const replace = (index: number, next: RecipeStep) =>
    onChange(steps.map((s, i) => (i === index ? next : s)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    if (step) next.splice(index + by, 0, step);
    onChange(next);
  };
  return (
    <div className="space-y-3" data-testid="recipe-editor">
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <StepCard
            key={step.id}
            step={step}
            index={i}
            total={steps.length}
            disabled={disabled}
            defaultAutonomy={defaultAutonomy}
            onChange={(s) => replace(i, s)}
            onMove={(by) => move(i, by)}
            onRemove={() => onChange(steps.filter((_, at) => at !== i))}
          />
        ))}
      </ol>
      {steps.length < RECIPE_MAX_STEPS ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-muted-foreground">Add a step:</span>
          {(Object.keys(STEP_KIND) as RecipeStep["type"][]).map((type) => (
            <Button
              key={type}
              size="xs"
              variant="outline"
              disabled={disabled}
              title={STEP_KIND[type].hint}
              onClick={() => onChange([...steps, newStep(type, steps, defaultAutonomy)])}
            >
              <Plus /> {STEP_KIND[type].label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          A recipe can have up to {RECIPE_MAX_STEPS} steps.
        </p>
      )}
    </div>
  );
}
