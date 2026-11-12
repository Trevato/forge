/** MCP `pulls` without `repo` (#7655): the pile across readable repositories; a pull's comments are one read. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createPull, type Pull } from "../src/core/pulls.ts";
import { addComment } from "../src/core/issues.ts";
import { submitReview } from "../src/core/reviews.ts";
import { setSealed } from "../src/core/sealed.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { askForReviews } from "./helpers/reviews.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};
let green: Pull;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function call(token: string, name: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = JSON.parse(await res.text());
  const out: string = body.result.content[0].text;
  return body.result.isError === true ? { error: out } : { value: JSON.parse(out) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-pile-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string, adminIfFirst = false) =>
    createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst,
    });
  const ada = ok(await make("ada", true));
  const rita = ok(await make("rita"));
  const sam = ok(await make("sam"));
  const open = async (repo: any, owner: any, b: string, author = owner): Promise<Pull> => {
    ok(await commitToBranch(app, owner, repo, { message: b, branch: b, files: [{ path: `${b}.txt`, content: `${b}\n` }] } as any));
    return ok(await createPull(app.db, repoDir(app.reposRoot, owner.username, repo.name), {
      repoId: repo.id, authorId: author.id, title: `Pull ${b}`, baseBranch: "main", headBranch: b,
    }));
  };
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "svc", visibility: "public" }));
  // Reviews are something an owner turns on (#11666): with them off these pulls would land.
  askForReviews(app.db, pub.id);
  const priv = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "vault", visibility: "private" }));
  for (const repo of [pub, priv])
    ok(await commitToBranch(app, ada, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  green = await open(pub, ada, "green");
  await open(priv, ada, "secret");
  const sealed = await open(pub, ada, "sealed", sam);
  await open(pub, ada, "third");
  setSealed(app.db, sealed.id, true);
  ok(submitReview(app.db, { issueId: green.id, authorId: rita.id, state: "approved", commitOid: green.headOid }));
  const run = createRun(app.db, { repoId: pub.id, kind: "check", issueId: green.id, commitOid: green.headOid });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "green" });
  ok(addComment(app.db, { issueId: green.id, authorId: sam.id, body: "looks fine to me" }));
  // A crew agent on the repository: it is told which commenters are outsiders.
  const bot = ok(await createAgent(app, ada, { username: "scoutbot", brief: "x" }));
  ok(await addToCrew(app, ada, pub, "scoutbot"));
  tok["bot"] = createToken(app.db, bot.user.id, "rw", "rw").token;
  tok["ada"] = createToken(app.db, ada.id, "rw", "rw").token;
  tok["rita"] = createToken(app.db, rita.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("without repo: open pulls the caller may read, oldest first, with verdict and gate", async () => {
  const { value } = await call(tok["rita"]!, "pulls", {});
  const titles = value.pulls.map((p: any) => p.title);
  // The private repository and the sealed pull are absent for rita.
  expect(titles).toEqual(["Pull green", "Pull third"]);
  expect(value.pulls[0]).toMatchObject({ repo: "ada/svc", number: 1, check: "ok", verdict: "approved" });
  expect(value.pulls[1]).toMatchObject({ verdict: "none", check: "none", gate: "waiting_review" });
  expect(value.next_cursor).toBeNull();
  // The owner reads the private repository and the sealed pull too.
  const all = (await call(tok["ada"]!, "pulls", {})).value.pulls.map((p: any) => p.title);
  expect(all).toEqual(["Pull green", "Pull secret", "Pull sealed", "Pull third"]);
});

test("pages with next_cursor and refuses a stale cursor", async () => {
  const first = (await call(tok["ada"]!, "pulls", { limit: 3 })).value;
  expect(first.pulls).toHaveLength(3);
  expect(first.next_cursor).not.toBeNull();
  const rest = (await call(tok["ada"]!, "pulls", { limit: 3, cursor: first.next_cursor })).value;
  expect(rest.pulls.map((p: any) => p.title)).toEqual(["Pull third"]);
  expect(rest.next_cursor).toBeNull();
  expect((await call(tok["ada"]!, "pulls", { cursor: "nope" })).error).toContain("cursor");
  expect((await call(tok["ada"]!, "pulls", { state: "closed" })).error).toBeDefined();
});

test("MCP pull carries the comments; the API read of a pull number already answered them", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/ada/svc/issues/${green.number}/comments`, {
    headers: { authorization: `Bearer ${tok["rita"]}` },
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).comments.map((c: any) => c.body)).toEqual(["looks fine to me"]);
  const { value } = await call(tok["rita"]!, "pull", { repo: "ada/svc", number: green.number });
  expect(value.comments).toMatchObject([{ author: "sam", body: "looks fine to me" }]);
  expect(value.commentsTotal).toBe(1);
  expect(value.commentsNext).toBeNull();
});

test("the outsider's comment is untrusted for a crew agent and unmarked for anyone else", async () => {
  const crew = (await call(tok["bot"]!, "pull", { repo: "ada/svc", number: green.number })).value;
  expect(crew.comments[0]).toMatchObject({ author: "sam", untrusted: true });
  const other = (await call(tok["rita"]!, "pull", { repo: "ada/svc", number: green.number })).value;
  expect("untrusted" in other.comments[0]).toBe(false);
});

test("past 50 comments the newest 50 come back with the total and the cursor of the older rest", async () => {
  const ada = getUserByName(app.db, "ada")!;
  const ids: string[] = [];
  for (let n = 0; n < 54; n++)
    ids.push(ok(addComment(app.db, { issueId: green.id, authorId: ada.id, body: `c${n}` })).id);
  const { value } = await call(tok["ada"]!, "pull", { repo: "ada/svc", number: green.number });
  expect(value.commentsTotal).toBe(55);
  expect(value.comments).toHaveLength(50);
  expect(value.comments.map((c: any) => c.body)).toEqual(ids.slice(4).map((_, n) => `c${n + 4}`));
  // The oldest comment returned is c4; its id is the cursor for the older rest.
  expect(value.commentsNext).toBe(ids[4]!);
});
