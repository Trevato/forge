/** /next lists its numbered rows in the dispatcher's order, with each fold's count right (#11734). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { nextUp, TOP } from "../src/core/next_up.ts";
import { sealedScope } from "../src/core/sealed.ts";
import { notStartable } from "../src/crew/not_startable.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;

const made3: number[] = [];
let alice: User;
let repo: Repo;

const COUNT = TOP + 3;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-next-order-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const made2 = await createRepo(app, alice, { name: "order", visibility: "public" });
  if (!made2.ok) throw new Error(JSON.stringify(made2.error));
  repo = made2.value;
  const gate = openIssue(app, alice, repo, { title: "Later gate: not now" });
  if (!gate.ok) throw new Error(String(gate.error));
  for (let i = 1; i <= COUNT; i++) {
    const o = openIssue(app, alice, repo, { title: `Issue ${i}` });
    if (!o.ok) throw new Error(String(o.error));
    made3.push(o.value.number);
  }
  // A known, non-creation order: 12 and 7 to the top, 2 and 5 into Later.
  for (const [n, to] of [[7, "top"], [12, "top"], [2, "not-now"], [5, "not-now"]] as const) {
    const r = rankIssue(app, alice, repo, made3[n - 1]!, to === "top" ? { to: "top" } : { to: "not_now" });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** Each fold's heading count and the issue numbers of its rows, in page order. */
function folds(page: string): { title: string; count: number; numbers: number[] }[] {
  return page.split("<details").slice(1).flatMap((chunk) => {
    const h = /<h2>([^<·]*?) · (\d+)<\/h2>/.exec(chunk);
    if (!h) return [];
    const numbers = [...chunk.matchAll(/<li[^>]*data-number="(\d+)"/g)].map((m) => Number(m[1]));
    return [{ title: h[1]!.trim(), count: Number(h[2]), numbers }];
  });
}

test("the numbered rows, the folds and Later follow the dispatcher's order", async () => {
  const page = await (await fetch(`${servers.url}/alice/order/next`, { headers: { cookie } })).text();
  const api = (await (await fetch(`${servers.url}/api/v1/repos/alice/order/queue`, { headers: { cookie } })).json()) as { queue: { position: number; number: number }[] };
  const order = api.queue.map((q) => q.number);
  expect(order.slice(0, 2)).toEqual([made3[11]!, made3[6]!]);
  expect(order.length).toBe(COUNT - 2);

  const [open, after, later] = folds(page);
  expect(open).toEqual({ title: "Up next", count: TOP, numbers: order.slice(0, TOP) });
  expect(after).toEqual({ title: "After", count: order.length - TOP, numbers: order.slice(TOP) });

  const parked = nextUp(app.db, repo, sealedScope(app.db, repo, alice), (ready) => notStartable(app, repo, ready, sealedScope(app.db, repo, alice))).notNow;
  expect(later!.title).toBe("Later");
  expect(later!.count).toBe(2);
  expect(later!.numbers).toEqual(parked.map((r) => r.issue.number));

  // The page numbers rows with the API's position.
  const lead = [...page.matchAll(/data-number="(\d+)"/g)].map((m) => Number(m[1]));
  expect(lead.slice(0, order.length)).toEqual(order);
});
