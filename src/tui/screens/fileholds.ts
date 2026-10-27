/**
 * Hold new work on a file, from the terminal (#6522): one line, the same
 * actions the settings page and the MCP tool call, so the admin check and
 * the hold's `by` are theirs.
 *
 *   owner/name path           hold new work on path
 *   release owner/name path   let it go
 *   owner/name                list the holds, who set them and when
 *   (a bare line)             list every hold in the repositories you administer
 */

import { holdFileAs, listFileHolds, releaseFileAs } from "../../actions/file_holds.ts";
import { boardHolds } from "../../core/admin_holds.ts";
import { getRepo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

const SAYS = {
  unauthorized: "Sign in first.",
  not_found: "No such repository, or you do not administer it.",
  invalid_path: "A path is relative, without .., under 300 characters.",
};

/** Run one line of the prompt; the sentence to show, as a toast or an error. */
export function fileHoldLine(f: Session, text: string): { ok: boolean; says: string } {
  const words = text.trim().split(/\s+/).filter((w) => w !== "");
  const release = words[0] === "release";
  if (release) words.shift();
  if (words.length === 0) {
    if (f.user === undefined) return { ok: false, says: SAYS.unauthorized };
    const { holds, total } = boardHolds(f.db, f.user);
    if (holds.length === 0) return { ok: true, says: "No file is held." };
    const cut = total > holds.length ? ` (${holds.length} of ${total})` : "";
    return { ok: true, says: holds.map((h) => `${h.repo} ${h.path}`).join("; ") + cut };
  }
  const [slug, path, ...extra] = words;
  const [owner, name, ...rest] = (slug ?? "").split("/");
  const repo = owner && name && rest.length === 0 ? getRepo(f.db, owner, name) : undefined;
  if (repo === undefined || extra.length > 0 || (release && path === undefined))
    return { ok: false, says: "Say: owner/name path, release owner/name path, or owner/name to list." };
  if (path === undefined) {
    const listed = listFileHolds(f.app, f.user, repo);
    if (!listed.ok) return { ok: false, says: SAYS[listed.error] };
    return {
      ok: true,
      says: listed.value.length === 0 ? "No file is held." : listed.value.map((h) => `${h.path} (${h.byName}, ${h.at.slice(0, 16)})`).join("; "),
    };
  }
  if (release) {
    const done = releaseFileAs(f.app, f.user, repo, path);
    return done.ok ? { ok: true, says: done.value ? `${path} is free again.` : `${path} was not held.` } : { ok: false, says: SAYS[done.error] };
  }
  const held = holdFileAs(f.app, f.user, repo, path);
  return held.ok ? { ok: true, says: `New work on ${held.value.path} is held.` } : { ok: false, says: SAYS[held.error] };
}

export function fileHoldsPrompt(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "Held files",
    label: "owner/name path · release owner/name path · owner/name · empty lists all",
    hint: "no build starts on an issue that names a held path",
    onSubmit: (text) => {
      const done = fileHoldLine(f, text);
      if (!done.ok) return done.says;
      ctx.toast(done.says);
      return undefined;
    },
  });
}
