/** A forge with a repository, and hourly series seeded for the efficiency watcher (#7558). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import { createRepo } from "../../src/core/repos.ts";
import { createUser } from "../../src/core/users.ts";
import { HOUR_MS } from "../../src/efficiency/baseline.ts";
import { putSample } from "../../src/efficiency/store.ts";
import { watch } from "../../src/efficiency/watch.ts";

export const MiB = 1024 ** 2;
export const DAY = 24 * HOUR_MS;
/** 2026-11-20T00:00Z: an hour boundary. */
export const T0 = Date.parse("2026-11-20T00:00:00Z");
export const NPM = "npm-registry-bytes";

export async function forge(): Promise<{ app: App; repoId: string; done(): void }> {
  const root = mkdtempSync(join(tmpdir(), "forge-efficiency-"));
  const app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error("user");
  const r = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "forge", visibility: "public", description: "" });
  if (!r.ok) throw new Error("repo");
  return { app, repoId: r.value.id, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** `hours` readings ending the hour before `end`, each `value(i)` with i counting from the first. */
export function seed(app: App, cause: string, end: number, hours: number, value: (i: number) => number): void {
  for (let i = 0; i < hours; i++) putSample(app.db, cause, end - (hours - i) * HOUR_MS, value(i));
}

export const flat = (app: App, end: number, v = 50 * MiB): void => seed(app, NPM, end, 8 * 24, () => v);

export function issuesOf(app: App, repoId: string): { id: string; number: number; title: string; state: string; body: string }[] {
  return app.db.query("SELECT id, number, title, state, body FROM issue WHERE repo_id = ?1 ORDER BY number").all(repoId) as never;
}

export const commentsOf = (app: App, issueId: string): string[] =>
  (app.db.query("SELECT body FROM comment WHERE issue_id = ?1 ORDER BY rowid").all(issueId) as { body: string }[]).map((c) => c.body);

export { watch };
