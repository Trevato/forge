/**
 * Who may fetch a look, and a pull's looks as a reader may see them: the one
 * rule behind the pictures on the web, the API read, MCP `pull` and the
 * terminal. Pure reads; no page, no request.
 */

import type { App } from "../app.ts";
import { previewEnv } from "../apps/data.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import { isAttached, looksForEnv, lookUrl, type Look } from "../core/looks.ts";
import type { Pull } from "../core/pulls.ts";
import { canEnterApp, canSeeOwnerFacts, type Repo } from "../core/repos.ts";
import { sealedPreview } from "../core/sealed.ts";
import type { User } from "../core/users.ts";
import { pairCounts, pairsLine } from "./pairs.ts";
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

/** The pairs line over a pull's looks for this reader (`pairs.ts`), or none. */
export function pullPairsLine(
  app: App,
  repo: Repo,
  pull: Pull,
  user: User | undefined,
): string | undefined {
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return undefined;
  const mine = (env: string) =>
    looksForEnv(app.db, record.id, env, "any").filter(
      (l) => !isAttached(l) && mayFetchLook(app, repo, record, l, user),
    );
  const head = mine(previewEnv(pull.number)).filter((l) => l.theme === "light");
  return pairsLine(pairCounts(head, mine("production")));
}

/** One page at one width: how it sat in the window it was pictured in. */
export interface PullFit {
  readonly page: string;
  readonly width: string;
  readonly scrollWidth: number;
  readonly innerWidth: number;
  readonly screens: number;
  readonly sideways: boolean;
}

/**
 * Which pages scroll sideways, from the sizes stored on a pull's looks of its
 * latest commit: numbers only, never a url or a picture, so the owner's own
 * looks count too. A sealed pull's is the writers'. Looks without a size are
 * left out. One query; no browser.
 */
export function pullFit(
  app: App,
  repo: Repo,
  pull: Pull,
  user: User | undefined,
): PullFit[] {
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return [];
  const env = previewEnv(pull.number);
  if (sealedPreview(app.db, repo.id, env) && !canSeeOwnerFacts(app.db, repo, user))
    return [];
  const looks = looksForEnv(app.db, record.id, env).filter((l) => l.error === null);
  const latest = looks[0]?.commitOid;
  const out: PullFit[] = [];
  // Newest first: the first look with a size per page and width is the one kept.
  const seen = new Set<string>();
  for (const l of looks) {
    const s = l.size;
    if (l.commitOid !== latest || !s || s.innerHeight <= 0) continue;
    const key = `${l.page} ${l.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      page: l.page,
      width: l.kind,
      scrollWidth: s.scrollWidth,
      innerWidth: s.innerWidth,
      screens: Math.round((s.scrollHeight / s.innerHeight) * 10) / 10,
      sideways: s.scrollWidth > s.innerWidth,
    });
  }
  return out;
}
