/**
 * A pull's own page reads only that pull's asks (#8389): `scoredFor` with
 * `only` says exactly what the full read says of that pull, and nothing of
 * the other pulls or of the repository's own asks (a parked issue).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { holdPull } from "../src/actions/holds.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import { scoredFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
const pulls: Record<"green" | "other" | "assigned" | "held", Pull> = {} as never;

async function pull(n: number, green: boolean): Promise<Pull> {
  const done = await commitToBranch(app, alice, repo, {
    branch: `topic/${n}`,
    base: "main",
    message: `change ${n}`,
    files: [{ path: `F${n}.md`, content: `${n}\n` }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const opened = await openPull(app, alice, repo, {
    title: `change ${n}`,
    body: "",
    baseBranch: "main",
    headBranch: `topic/${n}`,
  });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  if (green) {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: opened.value.id,
      env: `pull-${opened.value.number}`,
      commitOid: opened.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed" });
  }
  return opened.value;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-asks-one-pull-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  const created = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!created.ok) throw new Error(String(created.error));
  repo = created.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "start",
    files: [{ path: "README.md", content: "r\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  pulls.green = await pull(1, true);
  pulls.other = await pull(2, true);
  pulls.assigned = await pull(3, false);
  pulls.held = await pull(4, true);
  if (!assignIssue(app, alice, repo, pulls.assigned, alice).ok) throw new Error("assign");
  if (!holdPull(app, alice, repo, pulls.held, "not yet").ok) throw new Error("hold");
  const parked = openIssue(app, alice, repo, { title: "parked" });
  if (!parked.ok) throw new Error(String(parked.error));
  if (!addComment(app, alice, repo, parked.value, BREAKER_NOTE).ok) throw new Error("park");
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the full read holds a look, an assignment and a parked issue, and nothing for a held pull", () => {
  const ids = scoredFor(app.db, alice, [repo]).map((a) => a.id);
  expect(ids).toContain(`look:${pulls.green.id}`);
  expect(ids).toContain(`look:${pulls.other.id}`);
  expect(ids).toContain(`assigned:${pulls.assigned.id}`);
  expect(ids.some((id) => id.startsWith("parked:"))).toBe(true);
  expect(ids.some((id) => id.endsWith(pulls.held.id))).toBe(false);
});

test("narrowed to one pull, the read says exactly what the full read says of it", () => {
  const now = Date.now();
  const full = scoredFor(app.db, alice, [repo], now);
  for (const p of Object.values(pulls)) {
    const narrowed = scoredFor(app.db, alice, [repo], now, p.id);
    expect(narrowed.every((a) => a.pull?.id === p.id)).toBe(true);
    expect(narrowed.map((a) => ({ id: a.id, consequence: a.consequence }))).toEqual(
      full.filter((a) => a.pull?.id === p.id).map((a) => ({ id: a.id, consequence: a.consequence })),
    );
  }
  expect(scoredFor(app.db, alice, [repo], now, pulls.green.id).map((a) => a.id)).toEqual([
    `look:${pulls.green.id}`,
  ]);
  expect(scoredFor(app.db, alice, [repo], now, pulls.assigned.id).map((a) => a.id)).toEqual([
    `assigned:${pulls.assigned.id}`,
  ]);
  expect(scoredFor(app.db, alice, [repo], now, pulls.held.id)).toEqual([]);
});
