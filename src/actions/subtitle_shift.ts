/**
 * Shift every cue of a subtitle file by an offset and save it as one commit.
 * The web form and the terminal both call this, so the gate (a writer only),
 * the offset's range, the protected-default rule and the commit message are
 * one thing. The write is `editFiles`, so it lands as a push event and open
 * pages redraw.
 */

import type { App } from "../app.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { parseOffset, shiftCues, shiftMessage } from "../core/subtitle_shift.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { blobForRender, refTip } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import type { User } from "../core/users.ts";
import { err, type Result } from "../kernel/result.ts";
import { requireWriter } from "./access.ts";
import { editFiles, MAX_FILE_BYTES, type EditFilesError, type EditResult } from "./contents.ts";

export type ShiftError =
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "missing" }
  | EditFilesError;

/** Whether `path` is a subtitle path this action will touch. */
export const isSubtitlePath = (path: string): boolean => /\.(srt|vtt)$/i.test(path) && isSafeTreePath(path);

export async function shiftSubtitles(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: { readonly ref: string; readonly path: string; readonly offset: string },
): Promise<Result<EditResult, ShiftError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const { ref, path } = input;
  if (!isSafeRef(ref)) return err({ kind: "missing" });
  if (!isSubtitlePath(path)) return err({ kind: "refused", why: "Only a subtitle file (.srt, .vtt) can be shifted." });
  const offset = parseOffset(input.offset);
  if (!offset.ok) return err({ kind: "refused", why: offset.why });

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const blob = await blobForRender(dir, ref, path, MAX_FILE_BYTES);
  if (blob.kind !== "text") return err({ kind: "missing" });
  const moved = shiftCues(new TextDecoder().decode(blob.body), offset.ms);
  if (moved.cues === 0) return err({ kind: "refused", why: "This file has no cues to shift." });

  // A ref that is not a branch, or a protected default an ordinary writer
  // cannot commit to, takes the shift on a new branch and a pull.
  const isBranch = (await refTip(dir, `refs/heads/${ref}`)) !== undefined;
  const mustBranch = !isBranch || (ref === repo.defaultBranch && repo.protectDefault && !canAdmin(app.db, repo, writer.value));
  const subject = shiftMessage(offset.ms);
  const leaf = (path.split("/").pop() ?? path).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return editFiles(app, writer.value, repo, {
    branch: ref,
    base: ref,
    message: subject,
    files: [{ path, content: moved.text }],
    ...(mustBranch
      ? {
          newBranch: `${writer.value.username}/shift-${leaf === "" ? "file" : leaf}-${Date.now().toString(36)}`,
          openPull: { title: subject, body: "" },
        }
      : {}),
  });
}
