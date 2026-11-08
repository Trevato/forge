/**
 * Who may reply on a feed post, and to what. A reply is a comment on the
 * issue or pull the post links to, so the rule is the comment action's own:
 * a signed-in viewer who can read the repository (`requireParticipant`).
 * The page and the terminal both ask here, so they offer Reply to the same
 * people on the same posts.
 */
import type { Database } from "bun:sqlite";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { FeedItem } from "./rank.ts";

const THREAD_LINK = /^\/([^/]+)\/([^/#?]+)\/(issues|pulls)\/(\d+)(?:#[\w-]*)?$/;

export interface Thread {
  readonly owner: string;
  readonly name: string;
  readonly kind: "issues" | "pulls";
  readonly number: number;
}

/** The issue or pull a post's link names, or undefined when it names anything else. */
export function threadOf(link: string): Thread | undefined {
  const m = THREAD_LINK.exec(link);
  return m === null
    ? undefined
    : { owner: m[1]!, name: m[2]!, kind: m[3] as Thread["kind"], number: Number(m[4]) };
}

/** The path a reply posts to: the thread's comment form, without any anchor. */
export function replyPath(thread: Thread): string {
  return `/${thread.owner}/${thread.name}/${thread.kind}/${thread.number}/comments`;
}

/** The repository a viewer may reply in, or undefined: signed out, or one they cannot read. */
export function replyRepo(db: Database, viewer: User | undefined, app: string): Repo | undefined {
  if (viewer === undefined) return undefined;
  const [owner = "", name = ""] = app.split("/");
  const repo = getRepo(db, owner, name);
  return repo !== undefined && canRead(db, repo, viewer) ? repo : undefined;
}

/** The thread a viewer may reply on from this post, with its repository; undefined when there is none. */
export function replyTarget(
  db: Database,
  viewer: User | undefined,
  item: Pick<FeedItem, "app" | "link">,
): { thread: Thread; repo: Repo } | undefined {
  const thread = threadOf(item.link);
  if (thread === undefined || `${thread.owner}/${thread.name}` !== item.app) return undefined;
  const repo = replyRepo(db, viewer, item.app);
  return repo === undefined ? undefined : { thread, repo };
}
