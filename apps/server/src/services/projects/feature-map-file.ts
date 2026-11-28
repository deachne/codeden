import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  FEATURE_MAP_BRIEF_MAX,
  FEATURE_MAP_PATH,
  type FeatureMapResponse,
  type Project,
} from "@codeden/contracts";

/**
 * The project's feature map (§8.5): `.codeden/FEATURE_MAP.md`, beside the vision and the plan. A
 * plain list of every screen and button a person can reach, in the owner's words, so people and
 * agents name the same places. The Planner writes it with the owner. Briefs carry it
 * (`featureMapBrief`), cut to `FEATURE_MAP_BRIEF_MAX` characters. Owner checks are not part of it.
 */

export const FEATURE_MAP_TEMPLATE = `# Feature map

Every screen and button a person can reach, in the words you use for them. Agents read this file,
so the same names show up in their work and in your owner checks. Mark what isn't built yet with
"(planned)". How you'll check it works goes in Owner checks on the project page, which agents
never see.

## Home screen
- The "Add a link" box: where you paste a link to summarize
- The "Summarize" button: starts a summary of the link

## Summary page (planned)
- The "Copy" button: copies the summary
`;

function mapFile(project: Pick<Project, "path">): string {
  return resolve(project.path, FEATURE_MAP_PATH);
}

/** Read the feature map; the template (and `exists: false`) when the file is missing. */
export function readFeatureMap(project: Pick<Project, "path">): FeatureMapResponse {
  const file = mapFile(project);
  const exists = existsSync(file);
  return {
    path: FEATURE_MAP_PATH,
    exists,
    contents: exists ? readFileSync(file, "utf8") : FEATURE_MAP_TEMPLATE,
  };
}

/** Write the feature map atomically (in the main checkout; commit it to share it with agents). */
export function writeFeatureMap(
  project: Pick<Project, "path">,
  contents: string,
): FeatureMapResponse {
  const file = mapFile(project);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents.endsWith("\n") ? contents : `${contents}\n`);
  renameSync(tmp, file);
  return readFeatureMap(project);
}

/**
 * The feature map as a brief carries it: the file's text, cut at a line break to
 * `FEATURE_MAP_BRIEF_MAX` characters with a pointer to the file. Empty when there is no map or it
 * can't be read.
 */
export function featureMapBrief(project: Pick<Project, "path">): string {
  let text: string;
  try {
    const map = readFeatureMap(project);
    text = map.exists ? map.contents.trim() : "";
  } catch {
    return "";
  }
  if (text.length <= FEATURE_MAP_BRIEF_MAX) return text;
  const cut = text.slice(0, FEATURE_MAP_BRIEF_MAX);
  const end = cut.lastIndexOf("\n");
  return `${(end > 0 ? cut.slice(0, end) : cut).trimEnd()}\n\n(The feature map goes on: read the rest in \`${FEATURE_MAP_PATH}\`.)`;
}

/** The feature map as a block of a brief; empty when there is none. */
export function featureMapBlock(map: string | undefined): string {
  if (!map?.trim()) return "";
  return [
    "<feature_map>",
    `The project's feature map (\`${FEATURE_MAP_PATH}\`): the screens and buttons a person can reach, in the owner's words. Use these names for places in the app in your work and reports. Items marked "(planned)" aren't built yet. If your change adds, renames or removes a screen or button, say so in your report so the map can be kept current.`,
    "",
    map.trim(),
    "</feature_map>",
  ].join("\n");
}

/** A session's brief with the feature map after it (§8.5); the brief alone when there is none. */
export function withFeatureMap(brief: string, project: Pick<Project, "path">): string {
  const block = featureMapBlock(featureMapBrief(project));
  return block ? `${brief}\n\n${block}` : brief;
}
