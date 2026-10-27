/** A milestone's pace (#6848): closed per day, and the date it is on pace for, on the page and in the MCP. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { paceOf } from "../src/core/pace.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { milestoneData, milestonePage } from "../src/web/pages/milestones.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

// One instant for the whole file; every closing time is before it.
const NOW = new Date("2026-10-27T12:00:00.000Z");
const at = (daysAgo: number, hours = 1): string =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 - hours * 3_600_000).toISOString();

let root = "";
let app: App;
let repo: Repo;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-pace-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, u.value as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  repo = getRepo(app.db, "alice", "forge")!;
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const alice = () => getUserByName(app.db, "alice")!;
const make = (title: string): Issue => {
  const o = openIssue(app, alice(), repo, { title });
  if (!o.ok) throw new Error(String(o.error));
  return o.value;
};

/**
 * A milestone of `open` open leaves and one closed leaf for each entry of
 * `closedAt`, a closing time (a number is that many days before NOW).
 */
function milestone(name: string, open: number, closedAt: (number | string)[], gate?: Issue): Issue {
  const top = make(name);
  for (const [i, ago] of [...closedAt, ...Array(open).fill(null)].entries()) {
    const leaf = make(`${name} ${i}`);
    const linked = linkIssue(app, alice(), repo, top, leaf);
    if (!linked.ok) throw new Error(String(linked.error));
    if (ago === null) continue;
    expect(setIssueState(app, alice(), repo, getIssueById(app.db, leaf.id)!, "closed").ok).toBe(true);
    app.db
      .query("UPDATE issue SET closed_at = ?1 WHERE id = ?2")
      .run(typeof ago === "number" ? at(ago) : ago, leaf.id);
  }
  if (gate !== undefined && !linkIssue(app, alice(), repo, top, gate).ok) throw new Error("gate");
  return top;
}

const ctxFor = (number: number): Ctx =>
  ({
    app,
    request: new Request(`http://x/alice/forge/milestones/${number}`),
    url: new URL(`http://x/alice/forge/milestones/${number}`),
    params: { owner: "alice", name: "forge", number: String(number) },
    auth: { user: alice(), scope: undefined, via: "session" },
    theme: undefined,
  }) as Ctx;

/** The page's pace line and the MCP's data, both at NOW. */
async function both(top: Issue) {
  const html = await milestonePage(ctxFor(top.number), NOW).text();
  const line = /id="ms-pace"[\s\S]*?<span>([^<]*)<\/span>\s*<\/div>/.exec(html)?.[1];
  const data = (await milestoneData(ctxFor(top.number), repo, top.number, NOW))!;
  return { html, line, data };
}

test("on pace: 3 closed in 7 days and 2 open lands 5 days out; page and milestoneData, the MCP tool's read, agree", async () => {
  const top = milestone("Pace", 2, [0, 1, 2, 9]);
  const { html, line, data } = await both(top);
  expect(data["closedPerDay"]).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
  // 3 closed in the last 7 days: ceil(2 / (3 / 7)) = 5 days after 2026-10-27.
  expect(data["paceDate"]).toBe("2026-11-01");
  expect(line).toBe(`on pace for ${data["paceDate"]}`);
  expect(data["pace"]).toBe(line!);
  expect(html).toContain("<svg");
});

test("stalled: nothing closed in 7 days says so and has no date", async () => {
  const top = milestone("Stalled", 1, [10]);
  const { line, data } = await both(top);
  expect(line).toBe("no movement in 7 days");
  expect(data["paceDate"]).toBeNull();
});

test("done: nothing open says the day the last one closed", async () => {
  const top = milestone("Finished", 0, [3, 5]);
  const { line, data } = await both(top);
  expect(line).toBe("done 2026-10-24");
  expect(data["paceDate"]).toBeNull();
});

test("the pace line and the estimate above it use one window: an issue closed 6.75 days ago counts in both", async () => {
  // Oct 20 18:00 is inside the rolling 7 days, outside seven calendar days ending today.
  const top = milestone("Edge", 2, ["2026-10-20T18:00:00.000Z"]);
  const { html, line, data } = await both(top);
  expect(html).toContain("About 14 days at this week&#39;s pace");
  expect(line).toBe("on pace for 2026-11-10");
  expect(data["paceDate"]).toBe("2026-11-10");
});

test("deferred: the estimate gives no pace and the page shows no pace line either", async () => {
  const gate = make("Later gate: hold");
  const top = milestone("Held", 2, [1], gate);
  const { html, data } = await both(top);
  expect(html).toContain("Deferred");
  expect(html).not.toContain("ms-pace");
  expect(data["paceDate"]).toBeNull();
  expect(data["pace"]).toBe("");
});

test("paceOf reads no database: closing times in, buckets and a line out", () => {
  const input = { closedAt: [at(0), at(0), at(20)], total: 5, open: 2, deferred: false, closedInWindow: 2, window: 7, days: 7 };
  const pace = paceOf(input, NOW);
  expect(pace.closedPerDay.at(-1)).toBe(2);
  expect(pace.closedPerDay.reduce((a, b) => a + b, 0)).toBe(2);
  expect(pace.line).toBe("on pace for 2026-11-03");
  expect(paceOf({ ...input, deferred: true }, NOW).line).toBe("");
});
