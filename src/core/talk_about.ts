/**
 * What a talk is about: `owner/repo` or `owner/repo#N` (an issue or pull),
 * read from `/talk?about=` on the page and `talk --about` in the terminal.
 * One lookup for both doors, and it names nothing the viewer cannot read:
 * malformed, unknown and unreadable all answer null, so a private
 * repository's existence is not revealed.
 */

import type { Database } from "bun:sqlite";
import { getIssue } from "./issues.ts";
import { canRead, getRepo } from "./repos.ts";
import { mayViewId } from "./sealed.ts";
import type { User } from "./users.ts";

/** What `about` names: a repository, and an issue or pull of it when `number` is there. */
export interface About {
  readonly owner: string;
  readonly repo: string;
  readonly number?: number;
}
const ABOUT = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:#([1-9][0-9]{0,8}))?$/;

/** `owner/repo` or `owner/repo#N` read from text; null for anything else. Pure: it looks nothing up. */
export function parseAbout(text: string | null): About | null {
  const m = text === null || text.length > 140 ? null : ABOUT.exec(text);
  if (m === null) return null;
  return m[3] === undefined ? { owner: m[1]!, repo: m[2]! } : { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** The plain line "About owner/repo[#N: title]", or null when the text is malformed, unknown or not the viewer's to read. */
export function aboutLine(db: Database, text: string | null, viewer: User | undefined): string | null {
  const about = parseAbout(text);
  if (about === null) return null;
  const repo = getRepo(db, about.owner, about.repo);
  if (repo === undefined || !canRead(db, repo, viewer)) return null;
  const name = `${about.owner}/${about.repo}`;
  if (about.number === undefined) return `About ${name}`;
  const issue = getIssue(db, repo.id, about.number);
  if (issue === undefined || !mayViewId(db, repo, issue.id, viewer)) return null;
  return `About ${name}#${about.number}: ${issue.title}`;
}
