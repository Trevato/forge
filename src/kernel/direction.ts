/**
 * Four reviews in a week said "pipeline first, before any feature" (#11036).
 * A pull that adds a feature surface — a page (`src/web/pages/*.ts`), a
 * terminal screen (`src/tui/`) or a how-to (`docs/features/*.md`) — and
 * touches no pipeline code (`scripts/`, `src/flow/`, `src/nightly/`,
 * `src/checks/`, `forge.json`) must say why it goes ahead of the pipeline
 * items, as `Direction: <why>` in a commit message.
 */

import type { Change } from "./pin_edits.ts";

const FEATURE = /^(src\/web\/pages\/[^/]+\.ts|src\/tui\/.+\.ts|docs\/features\/[^/]+\.md)$/;
const PIPELINE = /^(scripts\/|src\/flow\/|src\/nightly\/|src\/checks\/|forge\.json$)/;
const WAIVER = /^Direction:[ \t]*\S[^\n]{9,}/im;

/** One line per problem: none unless a feature is added with no pipeline change and no Direction line. */
export function directionProblems(changes: readonly Change[], messages: readonly string[]): string[] {
  const features = changes.filter((c) => c.status.startsWith("A") && FEATURE.test(c.path)).map((c) => c.path);
  if (features.length === 0) return [];
  if (changes.some((c) => PIPELINE.test(c.path))) return [];
  if (messages.some((m) => WAIVER.test(m))) return [];
  const shown = features.slice(0, 3).join(", ") + (features.length > 3 ? ` and ${features.length - 3} more` : "");
  return [
    `rule "pipeline first": this pull adds a feature (${shown}) and no pipeline change (scripts/, src/flow/, src/nightly/, src/checks/, forge.json); change the pipeline, or put a "Direction: <why this goes ahead of the pipeline items>" line (10+ characters) in a commit message`,
  ];
}
