/**
 * The app a conversation is building (#11010): which repository, which
 * branch its turns commit to, and the pull that gives the branch a preview.
 * Plain rows in, plain rows out; the git side lives in `actions/build.ts`.
 */
import type { Database } from "bun:sqlite";

export interface ChatBuild {
  readonly conversationId: string;
  readonly repoId: string;
  readonly branch: string;
  /** The pull that previews the branch; set when the first version exists. */
  readonly pullNumber: number | null;
  readonly publishedAt: string | null;
}

interface Row {
  conversation_id: string;
  repo_id: string;
  branch: string;
  pull_number: number | null;
  published_at: string | null;
}

const build = (r: Row): ChatBuild => ({ conversationId: r.conversation_id, repoId: r.repo_id, branch: r.branch, pullNumber: r.pull_number, publishedAt: r.published_at });

/** The branch a conversation's turns commit to: server-made, never taken from a request. */
export const branchFor = (conversationId: string): string => `talk-${conversationId}`;

export function startChatBuild(db: Database, conversationId: string, repoId: string): ChatBuild {
  const branch = branchFor(conversationId);
  db.query("INSERT INTO chat_build (conversation_id, repo_id, branch, created_at) VALUES (?1,?2,?3,?4)").run(conversationId, repoId, branch, new Date().toISOString());
  return { conversationId, repoId, branch, pullNumber: null, publishedAt: null };
}

export function chatBuildOf(db: Database, conversationId: string): ChatBuild | undefined {
  const row = db.query("SELECT * FROM chat_build WHERE conversation_id = ?1").get(conversationId) as Row | null;
  return row === null ? undefined : build(row);
}

export function setBuildPull(db: Database, conversationId: string, pullNumber: number): void {
  db.query("UPDATE chat_build SET pull_number = ?2 WHERE conversation_id = ?1").run(conversationId, pullNumber);
}

export function setBuildPublished(db: Database, conversationId: string): void {
  db.query("UPDATE chat_build SET published_at = ?2 WHERE conversation_id = ?1").run(conversationId, new Date().toISOString());
}

/**
 * What the agent is told before every message of a building conversation:
 * where to work. Server text, so it is not fenced; the names in it are the
 * server's own (an owner and repository name already validated at creation).
 */
export function buildLead(repoName: string, branch: string, defaultBranch: string): string {
  return `You are building the app ${repoName} for this person. Make every change on the branch ${branch}, one commit for each request that changes code, with a short message saying what changed. Never commit to ${defaultBranch}: the person publishes from the page.\n\n`;
}

/** How many builds a person holds that are not yet published. */
export function unpublishedBuilds(db: Database, userId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM chat_build b JOIN conversation c ON c.id = b.conversation_id WHERE c.user_id = ?1 AND b.published_at IS NULL")
    .get(userId) as { n: number };
  return row.n;
}

export interface BuildRow {
  readonly conversationId: string;
  readonly title: string;
  readonly repoId: string;
  readonly published: boolean;
  readonly updatedAt: string;
}

/** A person's builds, most recently active first. */
export function buildsOf(db: Database, userId: string): BuildRow[] {
  const rows = db
    .query("SELECT b.conversation_id, b.repo_id, b.published_at, c.title, c.updated_at FROM chat_build b JOIN conversation c ON c.id = b.conversation_id WHERE c.user_id = ?1 ORDER BY c.updated_at DESC LIMIT 100")
    .all(userId) as { conversation_id: string; repo_id: string; published_at: string | null; title: string; updated_at: string }[];
  return rows.map((r) => ({ conversationId: r.conversation_id, title: r.title, repoId: r.repo_id, published: r.published_at !== null, updatedAt: r.updated_at }));
}
