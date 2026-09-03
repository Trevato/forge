/**
 * The two names the rest of the app knows file browsing by.
 *
 * There used to be two screens here — a directory listing you pushed into, and
 * a blob you pushed onto that — and the whole of that model is gone: browsing
 * code is one screen with an explorer and a preview (`screens/code.ts`). These
 * are the doors into it, kept because "open this directory" and "open this
 * file" are still the two things a caller means, and because a repo screen
 * should not have to know which pane it is asking for.
 */

import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { codeScreen } from "./code.ts";

export { formatSize } from "./code.ts";

/** Browse from a directory, with the explorer focused. */
export function treeScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  path = "",
): Screen {
  // A directory becomes "reveal this path and put the cursor there"; the
  // explorer expands to it and the preview follows the cursor as always.
  return codeScreen(f, ctx, src, ref, {
    ...(path === "" ? {} : { path: `${path}/` }),
    focus: "explorer",
  });
}

/** Open straight onto a file, with the file pane focused. */
export function blobScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  path: string,
): Screen {
  return codeScreen(f, ctx, src, ref, { path, focus: "file" });
}
