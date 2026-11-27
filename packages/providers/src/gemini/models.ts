import type { ModelInfo } from "@codeden/contracts";
import type { AcpModel } from "../acp/config";
import { DEFAULT_MODEL_ID } from "../util/model";

const CONFIGURED_MODEL = "The model selected in Gemini CLI (its own setting)";

/**
 * Gemini CLI's model aliases, which always point at its current models: listed until a session
 * reports the account's own list.
 */
const ALIASES: readonly ModelInfo[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Gemini CLI picks a Pro or Flash model for each task",
    efforts: [],
  },
  { id: "pro", label: "Pro", description: "Gemini CLI's current Pro model", efforts: [] },
  { id: "flash", label: "Flash", description: "Gemini CLI's current Flash model", efforts: [] },
  {
    id: "flash-lite",
    label: "Flash Lite",
    description: "Gemini CLI's current Flash Lite model",
    efforts: [],
  },
];

/**
 * Models the Gemini API serves that this Gemini CLI version may not list yet. Gemini CLI passes
 * any model name through to the API, so these work by name; they are added after the reported
 * models when missing. An account without access gets the API's own error on the first turn.
 */
const EXTRA_MODELS: readonly ModelInfo[] = [
  {
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    description: "Paid Gemini API tier only",
    efforts: [],
  },
];

/** "Default" leaves the choice to Gemini CLI's own setting. */
function defaultModel(): ModelInfo {
  return {
    id: DEFAULT_MODEL_ID,
    label: "Default",
    description: CONFIGURED_MODEL,
    efforts: [],
    isDefault: true,
  };
}

/** Until a Gemini session has listed its models: Default, then Gemini CLI's aliases. */
export function fallbackGeminiModels(): ModelInfo[] {
  return [
    defaultModel(),
    ...ALIASES.map((m) => ({ ...m })),
    ...EXTRA_MODELS.map((m) => ({ ...m })),
  ];
}

/**
 * The models a Gemini session reports (`models.availableModels`), after Default, then any
 * `EXTRA_MODELS` it left out. Gemini CLI has no reasoning-effort setting over ACP, so no model
 * offers efforts.
 */
export function geminiModelInfos(models: readonly AcpModel[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [defaultModel()];
  for (const m of models) {
    if (!m.id || m.id === DEFAULT_MODEL_ID || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      label: m.name || m.id,
      ...(m.description ? { description: m.description } : {}),
      efforts: [],
    });
  }
  for (const m of EXTRA_MODELS) if (!seen.has(m.id)) out.push({ ...m });
  return out;
}
