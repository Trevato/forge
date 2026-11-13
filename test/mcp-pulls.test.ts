/** MCP `pulls`: a brief line per pull, bounded input, private repositories not found, tools/list under its ceiling. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createPull, type Pull } from "../src/core/pulls.ts";
import { setIssueState } from "../src/core/issues.ts";
import { submitReview } from "../src/core/reviews.ts";
import { setSealed } from "../src/core/sealed.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function rpc(token: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { text: await res.text() };
}

async function pulls(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const { text } = await rpc(token, "tools/call", { name: "pulls", arguments: args });
  const body = JSON.parse(text);
  const out: string = body.result.content[0].text;
  return body.result.isError === true ? { error: out } : { value: JSON.parse(out) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-pulls-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string, adminIfFirst = false) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
  const ada = ok(await make("ada", true));
  const rita = ok(await make("rita"));
  const sam = ok(await make("sam"));
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "svc", visibility: "public" }));
  const priv = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "vault", visibility: "private" }));
  for (const repo of [pub, priv]) {
    ok(await commitToBranch(app, ada, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
    for (const b of ["one", "two"])
      ok(await commitToBranch(app, ada, repo, { message: b, branch: b, files: [{ path: `${b}.txt`, content: `${b}\n` }] } as any));
    for (const b of ["one", "two"])
      ok(await createPull(app.db, repoDir(app.reposRoot, ada.username, repo.name), {
        repoId: repo.id, authorId: ada.id, title: `Pull ${b}`, baseBranch: "main", headBranch: b,
      }));
  }
  // A third repository with the pulls whose state is the point.
  const lab = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "lab", visibility: "public" }));
  ok(await commitToBranch(app, ada, lab, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  const open = async (b: string, author = ada): Promise<Pull> => {
    ok(await commitToBranch(app, ada, lab, { message: b, branch: b, files: [{ path: `${b}.txt`, content: `${b}\n` }] } as any));
    return ok(await createPull(app.db, repoDir(app.reposRoot, ada.username, "lab"), {
      repoId: lab.id, authorId: author.id, title: `Pull ${b}`, baseBranch: "main", headBranch: b,
    }));
  };
  const reviewed = await open("reviewed");
  const asked = await open("asked");
  const sealed = await open("sealed", sam);
  const closed = await open("closed");
  ok(submitReview(app.db, { issueId: reviewed.id, authorId: rita.id, state: "approved", commitOid: reviewed.headOid }));
  ok(submitReview(app.db, { issueId: asked.id, authorId: ada.id, state: "changes_requested", commitOid: asked.headOid }));
  const run = createRun(app.db, { repoId: lab.id, kind: "check", issueId: reviewed.id, commitOid: reviewed.headOid });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "green" });
  setSealed(app.db, sealed.id, true);
  setIssueState(app.db, closed.id, "closed");
  tok["sam"] = createToken(app.db, sam.id, "rw", "rw").token;
  tok["ada"] = createToken(app.db, ada.id, "rw", "rw").token;
  tok["rita"] = createToken(app.db, rita.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("lists open pulls in the brief shape, newest first, limited", async () => {
  const all = (await pulls(tok["rita"]!, { repo: "ada/svc" })).value.pulls;
  expect(all.map((p: any) => p.number)).toEqual([2, 1]);
  expect(all[0]).toEqual({
    number: 2,
    title: "Pull two",
    author: "ada",
    head: "two",
    check: "none",
    approvals: 0,
    changesRequested: 0,
    mergeable: true,
  });
  expect((await pulls(tok["rita"]!, { repo: "ada/svc", limit: 1 })).value.pulls).toHaveLength(1);
  expect((await pulls(tok["rita"]!, { repo: "ada/svc", state: "closed" })).value.pulls).toEqual([]);
});

test("bad input stops at the boundary", async () => {
  for (const args of [
    { repo: "ada/svc", limit: 0 },
    { repo: "ada/svc", limit: 51 },
    { repo: "ada/svc", limit: "5" },
    { repo: "ada/svc", state: "all" },
  ])
    expect((await pulls(tok["ada"]!, args)).error).toBeDefined();
});

test("a private repository the caller cannot read is not found, as pull says", async () => {
  const theirs = await pulls(tok["rita"]!, { repo: "ada/vault" });
  const missing = await pulls(tok["rita"]!, { repo: "ada/nothing" });
  expect(theirs.error).toBeDefined();
  expect(theirs.error).toBe(missing.error);
  expect((await pulls(tok["ada"]!, { repo: "ada/vault" })).value.pulls).toHaveLength(2);
});

test("tools/list lists pulls and every page stays under 40 KB", async () => {
  const names: string[] = [];
  let params: { all: true; cursor?: string } = { all: true };
  for (;;) {
    const { text } = await rpc(tok["ada"]!, "tools/list", params);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(38_500); // headroom: a new tool must not tip the lane red
    const { result } = JSON.parse(text);
    names.push(...result.tools.map((t: any) => t.name));
    if (typeof result.nextCursor !== "string") break;
    params = { all: true, cursor: result.nextCursor };
  }
  expect(names).toContain("pulls");
});

const labPulls = async (who: string, args: object = {}): Promise<any[]> =>
  (await pulls(tok[who]!, { repo: "ada/lab", ...args })).value.pulls;

test("review and check state are counted, not assumed", async () => {
  const byHead = Object.fromEntries((await labPulls("rita")).map((p) => [p.head, p]));
  expect(byHead["reviewed"]).toMatchObject({ approvals: 1, changesRequested: 0, check: "ok" });
  expect(byHead["asked"]).toMatchObject({ approvals: 0, changesRequested: 1, check: "none" });
});

test("a closed pull is listed under state closed, with mergeable null", async () => {
  expect((await labPulls("rita")).map((p) => p.head)).not.toContain("closed");
  const closed = await labPulls("rita", { state: "closed" });
  expect(closed.map((p) => p.head)).toEqual(["closed"]);
  expect(closed[0].mergeable).toBeNull();
});

test("a sealed pull is seen by a writer and its reporter, not by a plain reader", async () => {
  const heads = async (who: string) => (await labPulls(who)).map((p) => p.head);
  expect(await heads("ada")).toContain("sealed");
  expect(await heads("sam")).toContain("sealed");
  expect(await heads("rita")).not.toContain("sealed");
});
