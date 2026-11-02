/**
 * Who may fetch a look, and a pull's looks as a reader may see them: the one
 * rule behind the pictures on the web, the API read, MCP `pull` and the
 * terminal. Pure reads; no page, no request.
 */

import type { App } from "../app.ts";
import { previewEnv } from "../apps/data.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import { looksForEnv, lookUrl, type Look } from "../core/looks.ts";
import type { Pull } from "../core/pulls.ts";
import { canEnterApp, canSeeOwnerFacts, type Repo } from "../core/repos.ts";
import { sealedPreview } from "../core/sealed.ts";
import type { User } from "../core/users.ts";
import { keepLook } from "./service.ts";

/**
 * Who may fetch a picture (#727, #738). Writers, all of them. Anyone else
 * only what was taken as nobody, and only of an app they may open (anyone
 * for a public app, a writer, the crew or a named person for a private
 * one): the thumb always, a public app's phone and desktop too. A picture
 * taken as the owner, an admin, stays the writers'; so does a thumb from
 * before thumbs were taken as nobody (`keepLook`), until it is retaken.
 */
export function mayFetchLook(
  app: App,
  repo: Repo,
  record: AppRecord,
  look: Look,
  user: User | undefined,
): boolean {
  if (canSeeOwnerFacts(app.db, repo, user)) return true;
  // A sealed pull's pictures are the writers' (`core/sealed.ts`).
  if (sealedPreview(app.db, repo.id, look.env)) return false;
  // A private app's pictures are for whoever may enter it (#620, #752): a
  // person it names sees them; a reader who is not named does not.
  if (!canEnterApp(app.db, repo, record, user)) return false;
  // Phone and desktop are a reader's only when taken as nobody — a public
  // app's, since #738; one taken as the owner stays the writers' (#727).
  if (look.kind !== "thumb") return look.takenAs === "nobody";
  return keepLook(app.config.dataDir, look);
}

export interface PullLook {
  readonly id: string;
  readonly width: string;
  readonly says: string | null;
  readonly by: string | null;
  readonly commit: string;
  readonly url: string;
  readonly at: string;
}

/**
 * A pull's looks, newest first, from its own preview environment and only
 * the ones this reader may fetch. Empty when the repository has no app.
 * The caller has already checked the reader may view the pull.
 */
export function pullLooks(
  app: App,
  repo: Repo,
  pull: Pull,
  user: User | undefined,
): PullLook[] {
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return [];
  const base = `/${repo.ownerName}/${repo.name}`;
  return looksForEnv(app.db, record.id, previewEnv(pull.number))
    .filter((l) => l.error === null && mayFetchLook(app, repo, record, l, user))
    .map((l) => ({
      id: l.id,
      width: l.kind,
      says: l.note,
      by: l.attachedBy,
      commit: l.commitOid,
      url: lookUrl(base, l),
      at: l.createdAt,
    }));
}
