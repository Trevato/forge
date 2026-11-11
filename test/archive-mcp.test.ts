/** MCP `archive`: an admin archives or wakes by name; a non-admin, an agent and a small token are refused. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let repo: Repo;
let second: Repo;
const tok: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const archived = (): boolean => getRepoById(app.db, repo.id)!.archivedAt !== null;

async function mcp(token: string, args: unknown, tool = "archive"): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-archive-mcp-"));
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
  const founder = ok(await make("founder", true));
  const mallory = ok(await make("mallory"));
  const org = ok(createOrg(app.db, "acme", founder.id));
  repo = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "svc", visibility: "public" }),
  );
  second = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "web", visibility: "public" }),
  );
  const bot = ok(await createAgent(app, founder, { username: "bot" }));
  expect(addToCrew(app, founder, repo, "bot").ok).toBe(true);
  const owners = listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
  addTeamMember(app.db, owners, bot.user.id);
  tok["founder"] = createToken(app.db, founder.id, "admin", "admin").token;
  tok["founderRw"] = createToken(app.db, founder.id, "rw", "rw").token;
  tok["mallory"] = createToken(app.db, mallory.id, "admin", "admin").token;
  tok["bot"] = createToken(app.db, bot.user.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("without `archived` it says how the repository is; with it, it plans first", async () => {
  expect((await mcp(tok["mallory"]!, { repo: "acme/svc" })).value).toEqual({ archived: false, repo: "acme/svc", since: null });
  const planned = await mcp(tok["founder"]!, { repo: "acme/svc", archived: true });
  expect(planned.value).toMatchObject({ dryRun: true, archived: true, was: false });
  expect(archived()).toBe(false);
});

test("a non-admin and an admin agent are refused, planning or not", async () => {
  for (const who of ["mallory", "bot"])
    for (const dryRun of [true, false]) {
      const tried = await mcp(tok[who]!, { repo: "acme/svc", archived: true, dryRun });
      expect(tried.error).toContain("forbidden");
      expect(archived()).toBe(false);
    }
});

test("an admin needs an admin token; then archives and wakes", async () => {
  const small = await mcp(tok["founderRw"]!, { repo: "acme/svc", archived: true, dryRun: false });
  expect(small.error).toContain("forbidden");
  expect(archived()).toBe(false);
  expect((await mcp(tok["founder"]!, { repo: "acme/svc", archived: "yes" })).error).toContain("true or false");
  const set = await mcp(tok["founder"]!, { repo: "acme/svc", archived: true, dryRun: false });
  expect(set.value).toMatchObject({ dryRun: false, archived: true, was: false });
  expect(archived()).toBe(true);
  expect((await mcp(tok["bot"]!, { repo: "acme/svc", archived: false, dryRun: false })).error).toContain("forbidden");
  expect(archived()).toBe(true);
  const woke = await mcp(tok["founder"]!, { repo: "acme/svc", archived: false, dryRun: false });
  expect(woke.value).toMatchObject({ archived: false, was: true });
  expect(archived()).toBe(false);
});

const asleep = (r: Repo): boolean => getRepoById(app.db, r.id)!.archivedAt !== null;

test("`repos`: a dry run over two changes nothing; applying archives both; the undo wakes both", async () => {
  const repos = ["acme/svc", "acme/web"];
  const planned = await mcp(tok["founder"]!, { repos });
  expect(planned.value.dryRun).toBe(true);
  expect(planned.value.rows.map((r: any) => r.outcome)).toEqual(["change", "change"]);
  expect(asleep(repo) || asleep(second)).toBe(false);

  const done = await mcp(tok["founder"]!, { repos, dryRun: false });
  expect(done.value.rows.map((r: any) => r.repo)).toEqual(["acme/svc", "acme/web"]);
  expect(done.value.rows.every((r: any) => r.outcome === "ok")).toBe(true);
  expect(asleep(repo) && asleep(second)).toBe(true);

  const undone = await mcp(
    tok["founder"]!,
    { app: "acme/svc", action: "undo", operation: done.value.operation, dryRun: false },
    "limb",
  );
  expect(undone.error).toBeUndefined();
  expect(asleep(repo) || asleep(second)).toBe(false);
});

test("`repos`: a non-admin is refused per row, an agent and a small token are refused outright", async () => {
  const repos = ["acme/svc", "acme/web", "acme/nope"];
  const tried = await mcp(tok["mallory"]!, { repos, dryRun: false });
  expect(tried.value.rows.map((r: any) => r.outcome)).toEqual(["refused", "refused", "refused"]);
  expect(asleep(repo) || asleep(second)).toBe(false);
  expect((await mcp(tok["bot"]!, { repos })).error).toContain("forbidden");
  expect((await mcp(tok["founderRw"]!, { repos, dryRun: false })).error).toContain("forbidden");
  expect((await mcp(tok["founder"]!, { repos: [] })).error).toContain("invalid");
  expect((await mcp(tok["founder"]!, { repo: "acme/svc", repos })).error).toContain("invalid");
  expect((await mcp(tok["founder"]!, { repos, archived: "yes" })).error).toContain("invalid");
  expect((await mcp(tok["founder"]!, { repos: Array(51).fill("acme/svc") })).error).toContain("invalid");
  expect(asleep(repo) || asleep(second)).toBe(false);
});

test("`repos` with `archived: false` wakes several in one operation", async () => {
  const repos = ["acme/svc", "acme/web"];
  await mcp(tok["founder"]!, { repos, dryRun: false });
  expect(asleep(repo) && asleep(second)).toBe(true);
  const woke = await mcp(tok["founder"]!, { repos, archived: false, dryRun: false });
  expect(woke.value.rows.map((r: any) => r.outcome)).toEqual(["ok", "ok"]);
  expect(typeof woke.value.operation).toBe("string");
  expect(asleep(repo) || asleep(second)).toBe(false);
});
