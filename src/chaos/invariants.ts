/**
 * What must be true after any fault. Each invariant returns the ways it is
 * broken, empty when it holds; plain strings, because they become an issue.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { repoDir } from "../git/repos.ts";
import { restoreSnapshot } from "../snapshot/restore.ts";
import { takeSnapshot } from "../snapshot/snapshot.ts";
import { dirStore } from "../snapshot/store.ts";
import { SEALED_VALUE, type World } from "./world.ts";

export interface Invariant {
  readonly name: string;
  /** Costly: checked once at the end of a night, not after every fault. */
  readonly final?: true;
  check(world: World): Promise<string[]>;
}

const STATES = ["queued", "running", "ok", "failed", "cancelled"];

/** Every run still exists and is in a state the table knows. */
const runsKept: Invariant = {
  name: "every run is queued, running or finished, and none vanished",
  async check(world) {
    const rows = world.app.db
      .query<{ id: string; state: string }, []>("SELECT id, state FROM run")
      .all();
    const have = new Set(rows.map((r) => r.id));
    const broken: string[] = [];
    for (const id of world.runIds)
      if (!have.has(id)) broken.push(`run ${id} vanished`);
    for (const r of rows)
      if (!STATES.includes(r.state))
        broken.push(`run ${r.id} is in state ${JSON.stringify(r.state)}`);
    return broken;
  },
};

/** The database is whole, and every open pull's head is in its bare repo. */
const pullsKeepHeads: Invariant = {
  name: "every open pull still has its head",
  async check(world) {
    const broken: string[] = [];
    const integrity = world.app.db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (integrity?.integrity_check !== "ok")
      broken.push(`integrity_check: ${integrity?.integrity_check}`);
    const pulls = world.app.db
      .query<{ head_oid: string; owner: string; name: string }, []>(
        `SELECT pull.head_oid, u.username AS owner, r.name AS name
           FROM pull JOIN issue ON issue.id = pull.issue_id
           JOIN repo r ON r.id = issue.repo_id JOIN user u ON u.id = r.owner_id
          WHERE issue.state = 'open' AND pull.merged_at IS NULL`,
      )
      .all();
    if (pulls.length === 0) broken.push("no open pull left");
    for (const p of pulls) {
      const dir = repoDir(world.app.reposRoot, p.owner, p.name);
      const has = Bun.spawnSync(["git", "cat-file", "-e", `${p.head_oid}^{commit}`], {
        cwd: dir,
        stdout: "ignore",
        stderr: "ignore",
      });
      if (has.exitCode !== 0) broken.push(`pull head ${p.head_oid} is gone from ${p.owner}/${p.name}`);
    }
    return broken;
  },
};

/** A snapshot taken now restores into an empty directory with the same runs. */
const snapshotRestores: Invariant = {
  name: "a snapshot taken after restores",
  final: true,
  async check(world) {
    const root = mkdtempSync(join(tmpdir(), "forge-chaos-snap-"));
    try {
      const store = dirStore(join(root, "store"));
      const manifest = await takeSnapshot(
        {
          db: world.app.db,
          dataDir: world.dataDir,
          reposRoot: world.app.reposRoot,
          version: "chaos",
        },
        store,
      );
      const into = join(root, "restored");
      await restoreSnapshot(store, manifest.name, into);
      const db = new Database(join(into, "forge.db"), { readonly: true });
      try {
        const have = new Set(
          db.query<{ id: string }, []>("SELECT id FROM run").all().map((r) => r.id),
        );
        return [...world.runIds]
          .filter((id) => !have.has(id))
          .map((id) => `run ${id} is not in the restored snapshot`);
      } finally {
        db.close();
      }
    } catch (error) {
      return [`snapshot or restore failed: ${String(error)}`];
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
};

/** The sealed value is in no file the forge writes, in the clear. */
const nothingSealedReadable: Invariant = {
  name: "no sealed value is readable",
  async check(world) {
    const broken: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile() && !p.endsWith("secret.key") && !p.endsWith(".sock")) {
          if (readFileSync(p).includes(SEALED_VALUE))
            broken.push(`the sealed value is readable in ${p.slice(world.dataDir.length)}`);
        }
      }
    };
    if (existsSync(world.dataDir)) walk(world.dataDir);
    return broken;
  },
};

export const INVARIANTS: readonly Invariant[] = [
  runsKept,
  pullsKeepHeads,
  snapshotRestores,
  nothingSealedReadable,
];
