/** The queue (#11618): every open issue in the order the dispatcher starts them, as data. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { placeOf, rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency, readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssue, setIssueState } from "../src/core/issues.ts";
import { nextUp, queueJson, REST_MAX } from "../src/core/next_up.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { notStartable } from "../src/crew/not_startable.ts";
import { inSlotOrder } from "../src/crew/autonomy.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the queue", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let vault: Repo;
  const n: Record<string, number> = {};
  const open = (title: string): number => {
    const o = openIssue(app, alice, repo, { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value.number;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-queue-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "q", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    for (const k of ["a", "b", "c", "d", "e", "f", "g", "h"]) n[k] = open(`Work ${k}`);
    const issue = (k: string) => getIssue(app.db, repo.id, n[k]!)!;
    addDependency(app.db, issue("b"), issue("a"), alice.id); // b waits for a, unranked
    addDependency(app.db, issue("d"), issue("c"), alice.id); // d waits for c, ranked
    addDependency(app.db, issue("g"), issue("h"), alice.id); // g waits for h, which is dropped: g is held for a person
    setIssueState(app.db, issue("h").id, "closed", "dropped");
    const v = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!v.ok) throw new Error(String(v.error));
    vault = v.value;
    openIssue(app, alice, vault, { title: "Secret plan" });
    rankIssue(app, alice, repo, n.e!, placeOf("top")!);
    rankIssue(app, alice, repo, n.d!, placeOf("top")!);
    rankIssue(app, alice, repo, n.f!, placeOf(`after:${n.d}`)!);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the rows that can start are the dispatcher's next starts, in its order; the rest say why", () => {
    const rows = nextUp(app.db, repo).rows;
    const startable = rows.filter((r) => r.state === "ready").map((r) => r.issue.number);
    const dispatcher = inSlotOrder(app, repo, readyNow(repoGraph(app.db, repo.id, { sealed: true }))).map((r) => r.issue.number);
    expect(startable).toEqual(dispatcher);
    expect(dispatcher.slice(0, 2)).toEqual([n.f!, n.e!]);
    const row = (k: string) => rows.find((r) => r.issue.number === n[k])!;
    expect(row("d").state).toBe("blocked");
    expect(row("d").why).toBe(`waits for #${n.c}`);
    // d is ranked, so it sits at its rank, ahead of the unranked; b, unranked and blocked, is last.
    expect(rows.map((r) => r.issue.number).slice(0, 3)).toEqual([n.d!, n.f!, n.e!]);
    // The ranked blocked row displaces no ready row: the first N rows that can start are the dispatcher's next N.
    expect(startable.slice(0, 3)).toEqual(dispatcher.slice(0, 3));
    expect(rows.filter((r) => r.state === "ready").map((r) => r.issue.number)).toEqual(dispatcher);
    // Unranked rows that cannot start sit last, by number: b waits, g is held.
    expect(rows.slice(-2).map((r) => r.issue.number)).toEqual([n.b!, n.g!]);
    expect(row("b").why).toBe(`waits for #${n.a}`);
    expect(row("g").state).toBe("held");
    expect(row("g").why).toContain("a blocker closed as dropped");
    expect(rows).toHaveLength(7);
    expect(nextUp(app.db, repo).unlisted).toBe(0);
  });

  test("GET /queue answers the same list as JSON", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/q/queue`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queue: { position: number; number: number; state: string }[] };
    expect(body.queue).toEqual(JSON.parse(JSON.stringify(queueJson(nextUp(app.db, repo, { sealed: true }, (ready) => notStartable(app, repo, ready, { sealed: true })).rows))));
    expect(body.queue[0]).toMatchObject({ position: 1, number: n.d! });
    expect(body.queue.map((q) => q.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("a page of the queue is asked for with limit and offset, and the total is said", async () => {
    const url = `${servers.url}/api/v1/repos/alice/q/queue`;
    const page = (await (await fetch(`${url}?limit=2&offset=1`)).json()) as { queue: { position: number }[]; total: number; limit: number; offset: number };
    expect(page.queue.map((q) => q.position)).toEqual([2, 3]);
    expect(page).toMatchObject({ total: 7, limit: 2, offset: 1 });
    for (const bad of ["limit=0", "limit=201", "limit=x", "offset=-1", "offset=x"])
      expect((await fetch(`${url}?${bad}`)).status).toBe(422);
  });

  test("a private repository's queue is not found for a guest, and a public one answers anonymously", async () => {
    expect((await fetch(`${servers.url}/api/v1/repos/alice/vault/queue`)).status).toBe(404);
    expect(nextUp(app.db, vault).rows).toHaveLength(1);
    expect((await fetch(`${servers.url}/api/v1/repos/alice/q/queue`)).status).toBe(200);
  });

  test("the rows past the cap are counted, not carried", () => {
    for (let i = 0; i < REST_MAX + 3; i++) {
      const o = openIssue(app, alice, vault, { title: `Waits ${i}` });
      if (!o.ok) throw new Error(String(o.error));
      addDependency(app.db, getIssue(app.db, vault.id, o.value.number)!, getIssue(app.db, vault.id, 1)!, alice.id);
    }
    const next = nextUp(app.db, vault);
    expect(next.unlisted).toBe(3);
    expect(next.rows.filter((r) => r.state === "blocked")).toHaveLength(REST_MAX);
  });
});
