import type { DevServerConfig, OwnerCheck } from "@codeden/contracts";

/**
 * The tryout agent's brief (§10.1, Owner checks): the only place a scenario's wording is ever
 * sent to an agent. The builder and the reviewer never get it; what they learn of a failed
 * scenario is its number and the tryout's observation.
 */

/** What the tryout tries: a factory PR, or a session's branch. */
export interface TryoutTarget {
  /** "pull request #12" or "the branch `feature/x`". */
  label: string;
}

/** The dev server line of the brief, from `.codeden/project.json`. */
function devServerLine(dev: DevServerConfig): string {
  const where = dev.cwd ? ` in \`${dev.cwd}\`` : "";
  const port = dev.port ? ` It listens on port ${dev.port}.` : "";
  return `Start the app with \`${dev.command}\`${where} (the \`devServer\` of \`.codeden/project.json\`; if this checkout's copy says otherwise, use that).${port} Install the dependencies first if they are missing, non-interactively. Run the server in the background so your shell stays free.`;
}

/** The tryout brief: start the app, try each scenario in the browser, submit the results. */
export function tryoutPrompt(
  target: TryoutTarget,
  checks: readonly Pick<OwnerCheck, "text">[],
  dev: DevServerConfig,
  featureMap = "",
): string {
  return [
    `**Owner checks**: you are the tryout agent for ${target.label}. You did not build or review this change. The project's owner wrote the scenarios below; check whether the app, as it is on this checkout, does each one, the way a person would use it.`,
    "",
    "Scenarios:",
    ...checks.map((c, n) => `${n + 1}. ${c.text}`),
    ...(featureMap.trim()
      ? [
          "",
          "The project's feature map lists the screens and buttons a person can reach, by the names the scenarios use. Use it to find the right place in the app:",
          "<feature_map>",
          featureMap.trim(),
          "</feature_map>",
        ]
      : []),
    "",
    devServerLine(dev),
    "Then use the app only through the browser tools: `browser_open_dev_server` or `browser_navigate` to open it, `browser_snapshot` to read the page, `browser_click`, `browser_type` and `browser_press` to use it. Don't change any file, and don't judge the code: judge what the app does.",
    "For each scenario, take a screenshot with `browser_screenshot` that shows the outcome, and decide `pass` (the app does what the scenario says) or `fail` (it doesn't, it errors, or you can't get there).",
    "When every scenario is tried, call `factory_submit_owner_checks` once with one result per scenario number: its state, the screenshot (the File path or artifact id `browser_screenshot` printed) and one sentence of what you saw the app do. Describe the app's behaviour in your own words and never repeat a scenario's wording: the builder reads your sentences, never the scenarios.",
    "If the app doesn't start, mark every scenario `fail` and say what happened in one sentence. Stop the dev server when you are done.",
  ].join("\n");
}

/** The nudge for a tryout that ended its turn without submitting results. */
export function tryoutNudge(count: number): string {
  return `**Owner checks**: you ended your turn without results. Finish trying the ${count === 1 ? "scenario" : `${count} scenarios`} of your brief, then call \`factory_submit_owner_checks\` with one result per scenario number. If the app can't be started, submit every scenario as \`fail\` with one sentence on why.`;
}
