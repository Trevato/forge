/** `/asked` reads as one sentence per ask: what was asked, then what became of it, linked to its evidence, needing-the-owner first (#5802). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { firstSentence } from "../src/core/asked.ts";
import { createIssue, addComment } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { askedLines } from "../src/tui/screens/asked.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DAY = 24 * 60 * 60 * 1000;
let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let alice: User;
let bot: User;
let repoId = "";
const numbers: Record<string, number> = {};

const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const ask = (key: string, title: string) => {
  const made = createIssue(app.db, { repoId, authorId: alice.id, title });
  if (!made.ok) throw new Error(made.error);
  numbers[key] = made.value.number;
  return made.value;
};

/** A pull by `author` whose body closes `issue`. */
const pullFor = (key: string, issue: { number: number }, author: User, extra: string) => {
  const made = createIssue(app.db, {
    repoId,
    authorId: author.id,
    title: `Answers ${issue.number}`,
    body: `Closes #${issue.number}`,
    kind: "pull",
  });
  if (!made.ok) throw new Error(made.error);
  numbers[key] = made.value.number;
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
            VALUES (?1, 'main', ?2, 'a', 'b', ?3)`)
    .run(made.value.id, key, extra === "" ? null : extra);
  return made.value;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-asked-outcomes-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const b = await createAgent(app, alice, { username: "bot" });
  if (!b.ok) throw new Error(String(b.error));
  bot = getUserByName(app.db, "bot")!;
  proveAll(app);
  const made = await createRepo(app, alice, { name: "garden" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;

  app.db.query("INSERT INTO repo_crew (repo_id, user_id) VALUES (?1, ?2)").run(repoId, bot.id);
  const landed = ask("landed", "Prune the roses");
  const merged = pullFor("landedPull", landed, bot, ago(1));
  app.db.query("UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)").run(landed.id, merged.id);
  const old = ask("old", "Paint the shed");
  const oldPull = pullFor("oldPull", old, bot, ago(20));
  app.db.query("UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)").run(old.id, oldPull.id);

  const building = ask("building", "A watering schedule");
  pullFor("buildingPull", building, bot, "");

  const parked = ask("parked", "Plant tomatoes in the north bed");
  const parkedPull = pullFor("parkedPull", parked, bot, "");
  app.db.query("UPDATE issue SET state = 'closed', parked = 1 WHERE id = ?1").run(parkedPull.id);
  addComment(app.db, {
    issueId: parkedPull.id,
    authorId: bot.id,
    body: "Parked by the crew: the check failed twice on the same test. Run it again by hand.",
  });
  addComment(app.db, { issueId: parkedPull.id, authorId: alice.id, body: "Parked by the crew: spoofed" });

  const failed = ask("failed", "Fix the gate");
  const run = createRun(app.db, { repoId, kind: "agent", issueId: failed.id, actorId: bot.id });
  app.db.query("UPDATE run SET state = 'failed' WHERE id = ?1").run(run.id);

  ask("unplaced", "x".repeat(100));
  ask("spaced", `${"word ".repeat(15)}tails and more tail`);

  const dropped = ask("dropped", "Dropped idea");
  app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(dropped.id);

  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const read = async () => {
  const res = await fetch(`${servers.url}/asked?show=all`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.text()).replace(/\s+/g, " ");
};
/** The row holding this ask's title, as text and as hrefs. */
const rowOf = (page: string, title: string) => {
  const at = page.indexOf(`>${title}</a>`);
  expect(at).toBeGreaterThan(-1);
  const start = page.lastIndexOf("<li", at);
  const end = page.indexOf("</li>", at);
  const li = page.slice(start, end);
  return {
    text: li.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    hrefs: [...li.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!),
  };
};

test("each state reads as one sentence with a link to its evidence", async () => {
  const page = await read();
  const n = numbers;
  const landed = rowOf(page, "Prune the roses");
  expect(landed.text).toContain(`landed in #${n.landedPull}`);
  expect(landed.hrefs).toContain(`/alice/garden/pulls/${n.landedPull}`);
  expect(landed.hrefs).toContain(`/alice/garden/issues/${n.landed}`);

  const building = rowOf(page, "A watering schedule");
  expect(building.text).toContain(`botcrew building in #${n.buildingPull}`);
  expect(building.hrefs).toContain(`/alice/garden/pulls/${n.buildingPull}`);

  const parked = rowOf(page, "Plant tomatoes in the north bed");
  expect(parked.text).toContain("parked: the check failed twice on the same test.");
  expect(parked.text).not.toContain("Run it again");
  expect(parked.hrefs).toContain(`/alice/garden/pulls/${n.parkedPull}`);

  const failed = rowOf(page, "Fix the gate");
  expect(failed.text).toContain("botcrew failed");
  expect(failed.hrefs).toContain(`/alice/garden/issues/${n.failed}`);

  const unplaced = rowOf(page, `${"x".repeat(79)}…`);
  expect(unplaced.text).toContain("not placed yet");
  expect(unplaced.hrefs).toContain(`/alice/garden/issues/${n.unplaced}`);
});

test("what needs the owner comes first, then progress, then what landed", async () => {
  const page = await read();
  const at = (t: string) => page.indexOf(`>${t}</a>`);
  const order = ["Plant tomatoes in the north bed", "Fix the gate", "A watering schedule", "Prune the roses"].map(at);
  expect(order.every((i) => i > -1)).toBe(true);
  expect(order[0]!).toBeLessThan(order[2]!);
  expect(order[1]!).toBeLessThan(order[2]!);
  expect(order[2]!).toBeLessThan(order[3]!);
  expect(page.indexOf(`>${"x".repeat(79)}…</a>`)).toBeLessThan(order[3]!);
  expect(at("Paint the shed")).toBeGreaterThan(order[2]!);
});

test("the API, the MCP and the terminal carry the same outcome and sentence", async () => {
  const res = await fetch(`${servers.url}/api/v1/asked?show=all`, { headers: { authorization: `Bearer ${createToken(app.db, alice.id, "ro", "ro").token}` } });
  const rows = ((await res.json()) as any).asked as any[];
  const by = (t: string) => rows.find((r) => r.title === t);
  expect(by("Prune the roses").outcome.kind).toBe("landed");
  expect(by("Prune the roses").outcomeText).toBe(`landed in #${numbers.landedPull}`);
  expect(by("Plant tomatoes in the north bed").outcomeText).toBe("parked: the check failed twice on the same test.");
  expect(by("Fix the gate").outcome).toMatchObject({ kind: "failed", by: "bot" });
  const lines = askedLines(app.db, getUserByName(app.db, "alice")!).asks;
  // Found by title: the terminal keeps MCP's order, not the page's grouping (#7303).
  expect(lines.find((l) => l.title === "Plant tomatoes in the north bed")?.secondary).toStartWith("parked: the check failed twice");
});

test("All lists every ask it counts, closed ones last", async () => {
  const page = await read();
  const counted = Number(page.match(/>All<span class="pill" >(\d+)</)?.[1]);
  expect(counted).toBeGreaterThan(0);
  expect(page.split('<div class="row"').length - 1).toBe(counted);
  const dropped = rowOf(page, "Dropped idea");
  expect(dropped.text).toContain("closed, nothing merged");
  expect(page.indexOf(">Dropped idea</a>")).toBeGreaterThan(page.indexOf(">Prune the roses</a>"));
});

test("a name in the sentence wears its mark, outside the link", async () => {
  const page = await read();
  const li = page.slice(page.lastIndexOf("<li", page.indexOf(">A watering schedule</a>")), page.indexOf("</li>", page.indexOf(">A watering schedule</a>")));
  expect(li).toContain('data-mark="crew"');
  expect(li).not.toMatch(/<a [^>]*>[^<]*bot/);
  const lines = askedLines(app.db, alice).asks.map((l) => l.secondary);
  expect(lines.some((t) => t?.startsWith("bot (crew) building in #"))).toBe(true);
});

test("a parking note is cut at its first sentence", () => {
  expect(firstSentence("the check failed. Then more.")).toBe("the check failed.");
  expect(firstSentence("no full stop")).toBe("no full stop");
});

test("a long ask is cut at the last space before 80 characters", async () => {
  const page = await read();
  expect(page).toContain(`>${"word ".repeat(15).trim()}…</a>`);
});
