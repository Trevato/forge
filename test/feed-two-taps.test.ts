/**
 * From any post a person reaches its files, diff, run or terminal in two taps
 * (docs/VISION.md, P1): one repository with an event of each kind the feed
 * builds; for each post, its own link is tap 1 and a link on that page to the
 * promised depth is tap 2, and both answer 200.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { recordLook } from "../src/core/looks.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
let cookie = "";
const base = "/alice/forge";
let mergedNumber = 0;
let openNumber = 0;
let runId = "";
let headOid = "";
let mergeOid = "";
let token = "";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-feed-two-taps-"));
  app = createApp({ dataDir: root, port: 0, disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
  servers = await serve(app);
  alice = must(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  repo = must(await createRepo(app, alice, { name: "forge", visibility: "public" }));
  must(
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# forge\n" }],
    }),
  );
  const pull = async (branch: string, title: string) => {
    must(
      await commitToBranch(app, alice, repo, {
        branch,
        base: "main",
        message: title,
        files: [{ path: `${branch}.md`, content: `${branch}\n` }],
      }),
    );
    return must(
      await openPull(app, alice, repo, { title, body: "", baseBranch: "main", headBranch: branch }),
    );
  };

  // A pull opened and merged through the real actions, so `pull.opened` and
  // `pull.merged` carry the payloads the forge writes. A decision to land it
  // is recorded first; the merge resolves it.
  const merged = await pull("done", "Merged change");
  mergedNumber = merged.number;
  headOid = merged.headOid;
  recordDecision(app.db, {
    kind: "land",
    repoId: repo.id,
    issueId: merged.id,
    state: "x",
    answer: "yes",
    p: 1,
    by: "alice",
    ms: 1,
  });
  mergeOid = must(await mergePull(app, alice, repo, merged, "merge")).mergeOid;

  // A green open pull: an ask.
  const open = await pull("feat", "Green change");
  openNumber = open.number;
  const check = createRun(app.db, {
    repoId: repo.id,
    kind: "check",
    issueId: open.id,
    env: `pull-${open.number}`,
    commitOid: open.headOid,
    reason: "pull",
  });
  claimRun(app.db, check.id);
  finishRun(app.db, check.id, { state: "ok", summary: "green" });

  // A run. `run.finished`, `look.taken` and `app.serving` are written by the
  // runner, the look service and the release, which a test cannot start, so
  // these three events are appended with the payloads those write.
  const run = createRun(app.db, { repoId: repo.id, kind: "check", summary: "worked" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "worked", costUsd: 0 });
  runId = run.id;
  app.bus.append({
    kind: "run.finished",
    repoId: repo.id,
    actorId: alice.id,
    payload: { kind: "check", state: "ok", summary: "worked", runId },
  });

  // A look of the merged pull.
  const record = must(insertApp(app.db, { repoId: repo.id, slug: "garden", access: "public" }));
  const env = `pull-${mergedNumber}`;
  const path = `looks/${record.id}/${env}/${headOid}-thumb.png`;
  mkdirSync(join(root, "looks", record.id, env), { recursive: true });
  writeFileSync(join(root, path), "png");
  recordLook(app.db, { appId: record.id, env, commitOid: headOid, kind: "thumb", path, takenAs: "nobody" });
  const phone = `looks/${record.id}/${env}/${headOid}-phone.png`;
  writeFileSync(join(root, phone), "png");
  recordLook(app.db, { appId: record.id, env, commitOid: headOid, kind: "phone", path: phone, takenAs: "nobody" });
  app.bus.append({ kind: "look.taken", repoId: repo.id, payload: { env, commitOid: headOid } });

  // A release.
  app.bus.append({
    kind: "app.serving",
    repoId: repo.id,
    payload: { version: "0.1.1", commitOid: mergeOid, pulls: [{ title: "Merged change" }] },
  });

  // A private repository with a run and a pull: none of it is a guest's.
  const secret = must(await createRepo(app, alice, { name: "secret", visibility: "private" }));
  must(
    await commitToBranch(app, alice, secret, {
      message: "seed",
      files: [{ path: "README.md", content: "# secret\n" }],
    }),
  );
  must(
    await commitToBranch(app, alice, secret, {
      branch: "hidden",
      base: "main",
      message: "Hidden change",
      files: [{ path: "h.md", content: "h\n" }],
    }),
  );
  must(
    await openPull(app, alice, secret, {
      title: "Hidden change",
      body: "",
      baseBranch: "main",
      headBranch: "hidden",
    }),
  );
  app.bus.append({
    kind: "run.finished",
    repoId: secret.id,
    actorId: alice.id,
    payload: { kind: "check", state: "ok", summary: "hidden", runId: "hidden-run" },
  });
  token = createToken(app.db, alice.id, "ro", "ro").token;
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, as: string | null = cookie) =>
  fetch(`${servers.url}${path}`, { headers: as === null ? {} : { cookie: as }, redirect: "manual" });
const guest = (path: string) => get(path, null);

interface Item {
  id: string;
  app: string;
  kind: string;
  link: string;
  what: string;
}
const feed = async (): Promise<Item[]> => {
  const res = await get("/api/v1/feed?limit=50");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Item[] }).items;
};

const hrefs = (html: string): string[] =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));

/** Kinds this file proves. The feed builds milestone, map, cost, tell, reply and choose too: they need
 * a watched milestone, a blocked issue, an agent run over $1 and so on, and are not covered here. */
const COVERED = ["pull", "run", "look", "release", "ask", "decision"];
const NOT_COVERED = ["milestone", "map", "cost", "tell", "reply", "choose"];

let home: string[] | undefined;
const homeHrefs = async (): Promise<string[]> => (home ??= hrefs(await (await get("/feed")).text()));

/**
 * Tap 1: the post's `link` is an href on the home page a person sees, and it
 * answers. Tap 2: that page holds a link matching `depth`, which answers too.
 * A guest gets the same two answers for a public repository.
 */
async function twoTaps(item: Item, depth: RegExp): Promise<string> {
  expect(await homeHrefs(), `home carries a card href for ${item.kind} ${item.link}`).toContain(item.link);
  const first = await get(item.link);
  expect(first.status).toBe(200);
  const second = hrefs(await first.text()).find((h) => depth.test(h));
  expect(second, `${item.kind} ${item.link} links to ${depth}`).toBeDefined();
  expect((await get(second!)).status).toBe(200);
  expect((await guest(item.link)).status).toBe(200);
  expect((await guest(second!)).status).toBe(200);
  return second!;
}

const one = (items: Item[], kind: string, says: RegExp): Item => {
  const found = items.find((i) => i.kind === kind && says.test(i.what));
  expect(found, `a ${kind} post that says ${says}`).toBeDefined();
  return found!;
};

test("the feed carries a post of every covered kind and no kind unaccounted for", async () => {
  expect((await get("/feed")).status).toBe(200);
  const kinds = new Set((await feed()).map((i) => i.kind));
  for (const k of COVERED) expect(kinds.has(k), k).toBe(true);
  for (const k of kinds) expect([...COVERED, ...NOT_COVERED], `kind ${k} needs a two-taps test`).toContain(k);
});

test("a pull reaches its diff in two taps", async () => {
  const item = one(await feed(), "pull", /merged a pull request/);
  const to = await twoTaps(item, new RegExp(`^${base}/pulls/${mergedNumber}/files`));
  expect(to).toContain(`/pulls/${mergedNumber}/files`);
});

test("a run's page is its log: one tap, not two", async () => {
  const item = one(await feed(), "run", /check run finished/);
  expect(await homeHrefs()).toContain(item.link);
  expect(item.link).toBe(`${base}/runs/${runId}`);
  const page = await get(item.link);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('id="run-log"');
  expect((await get(`/api/v1/repos/alice/forge/runs/${runId}/log`)).status).toBe(200);
  expect((await guest(item.link)).status).toBe(200);
});

test("a look reaches its picture in two taps", async () => {
  const item = one(await feed(), "look", /a new picture of #/);
  await twoTaps(item, new RegExp(`^${base}/looks/pull-${mergedNumber}/${headOid}/`));
});

test("a release reaches its commit tree in two taps", async () => {
  const item = one(await feed(), "release", /0\.1\.1 is serving/);
  expect(item.link).toBe(`${base}/commit/${mergeOid}`);
  await twoTaps(item, new RegExp(`^${base}/tree/${mergeOid}`));
});

test("an ask reaches the thing asked about, and from it the diff", async () => {
  const item = one(await feed(), "ask", /./);
  expect(item.link).toBe(`${base}/pulls/${openNumber}`);
  await twoTaps(item, new RegExp(`^${base}/pulls/${openNumber}/files`));
});

test("a decision reaches the pull it was about, and from it the diff (it was the list of pulls, three taps)", async () => {
  const item = one(await feed(), "decision", /chose/);
  await twoTaps(item, new RegExp(`^${base}/pulls/${mergedNumber}/files`));
});

test("the MCP feed tool carries the same posts with the same links", async () => {
  const api = await feed();
  const mcp = await mcpTool(servers.url, token, "feed", { limit: 50 });
  expect(mcp.error).toBeUndefined();
  const seen = new Map<string, string>((mcp.value.items as Item[]).map((i) => [i.id, i.link]));
  for (const i of api) expect(seen.get(i.id), `${i.kind} ${i.id} over MCP`).toBe(i.link);
  for (const k of COVERED) expect((mcp.value.items as Item[]).some((i) => i.kind === k), k).toBe(true);
});

test("a guest gets no private post, and the private repository answers 404", async () => {
  const items = await feed();
  expect(items.some((i) => i.app === "alice/secret")).toBe(true);
  expect((await guest("/api/v1/feed")).status).toBe(401);
  const page = await (await guest("/")).text();
  expect(page).not.toContain("alice/secret");
  expect(page).not.toContain("Hidden change");
  for (const i of items.filter((x) => x.app === "alice/secret")) {
    expect(i.link.startsWith("/alice/secret"), i.link).toBe(true);
    expect((await guest(i.link)).status).toBe(404);
  }
  expect((await guest("/alice/secret/pulls/1/files")).status).toBe(404);
});
