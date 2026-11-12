import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import { openPull } from "../../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../../src/actions/repos.ts";
import type { Red } from "../../src/checks/queue.ts";
import { getPull, type Pull } from "../../src/core/pulls.ts";
import { getRepoById, type Repo } from "../../src/core/repos.ts";
import { createUser, type User } from "../../src/core/users.ts";

export interface Doctor {
  readonly app: App;
  readonly alice: User;
  readonly repo: Repo;
  /** Open one more pull from a fresh branch. */
  pull(path: string): Promise<Pull>;
  close(): Promise<void>;
}

/** A forge with one person, one repository, and a way to open pulls: what the doctor treats. */
export async function doctorWorld(name: string): Promise<Doctor> {
  const dataDir = await mkdtemp(join(tmpdir(), `forge-doctor-${name}-`));
  const app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const alice = a.value;
  const made = await createRepo(app, alice, { name, visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, alice, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: `# ${name}\n` }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const repo = getRepoById(app.db, made.value.id)!;
  return {
    app,
    alice,
    repo,
    async pull(path) {
      const pushed = await commitToBranch(app, alice, repo, {
        branch: `feature/${path}`,
        base: "main",
        message: path,
        files: [{ path, content: `export const n = "${path}";\n` }],
      });
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
      const opened = await openPull(app, alice, repo, { title: path, baseBranch: "main", headBranch: `feature/${path}` });
      if (!opened.ok) throw new Error(String(opened.error));
      return getPull(app.db, repo.id, opened.value.number)!;
    },
    async close() {
      await app.close?.();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A red verdict naming one failing test with this error line. */
export function redFor(name: string, file: string, error: string, reason: Red["reason"] = { kind: "tests", failed: 1 }): Red {
  return {
    lands: false,
    reopen: true,
    comment: "red",
    learn: [file],
    ...(reason === undefined ? {} : { reason }),
    tests: { passed: 10, failed: 1, failing: [{ name, file, errors: [error] }] },
  };
}
