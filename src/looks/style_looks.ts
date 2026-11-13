/**
 * The looks a stylesheet change must carry before it is approved (#11831
 * item 5): the home page at phone and desktop width, taken at the pull's head.
 * Main's picture of the same page sits beside them on the pull page
 * (`pairs.ts`), so the reviewer sees before and after. Plain data in, plain
 * data out; it reads nothing.
 */

import { DEFAULT_PAGE, type Look, type LookKind } from "../core/looks.ts";

/** Where the forge's stylesheet sources live. */
const STYLE_ROOT = "src/web/style/";

const WIDTHS: readonly LookKind[] = ["phone", "desktop"];

/** Whether any changed path is a stylesheet source. */
export const touchesStylesheet = (paths: readonly string[]): boolean =>
  paths.some((p) => p.startsWith(STYLE_ROOT));

/**
 * The widths of the home page the head has no picture of: `looks` are the
 * pull preview's forge-taken looks. A look that failed, or was taken at an
 * earlier head, does not count.
 */
export function missingHomeLooks(
  looks: readonly Look[],
  headOid: string,
): LookKind[] {
  return WIDTHS.filter(
    (kind) =>
      !looks.some(
        (l) =>
          l.page === DEFAULT_PAGE &&
          l.kind === kind &&
          l.theme === "light" &&
          l.error === null &&
          l.attachedBy === null &&
          l.commitOid === headOid,
      ),
  );
}
