/** GET /api/v1/user/assigned carries an ETag and answers a repeat with 304 (#9177). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, setIssueState, updateIssueText } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let aliceId = "";
let repoId = "";
let aliceTok = "";
let aliceRo = "";
let aliceWrite = "";
let bobTok = "";
const cells = process.env["FORGE_CELLS"];
const URL_ = "/api/v1/user/assigned";
const get = (tok: string | null, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${URL_}`, { headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers } });
const tagOf = async (tok: string) => {
  const res = await get(tok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};
const assign = (n: number, assignee: string | null) =>
  fetch(`${servers.url}/api/v1/repos/alice/a/issues/${n}/assignee`, {
    method: "PUT",
    headers: { authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
    body: JSON.stringify({ assignee }),
  });
const open = (title: string) => {
  const made = createIssue(app.db, { repoId, authorId: aliceId, title });
  if (!made.ok) throw new Error("issue");
  return made.value;
};
/** Expect the held tag to be stale: 200 with a different tag; return the new tag. */
const moved = async (tok: string, held: string) => {
  const res = await get(tok, { "if-none-match": held });
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).not.toBe(held);
  await res.text();
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-assigned-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  aliceId = alice.id;
  const r = await createRepo(app, alice, { name: "a", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  repoId = r.value.id;
  aliceTok = createToken(app.db, alice.id, "t", "admin").token;
  aliceRo = createToken(app.db, alice.id, "r", "ro").token;
  aliceWrite = createToken(app.db, alice.id, "w", "rw").token;
  bobTok = createToken(app.db, bob.id, "b", "ro").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a weak tag, private no-cache, vary", async () => {
  const res = await get(aliceRo);
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\/"/);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
});

test("a repeat is a bodiless 304 with the floor", async () => {
  const tag = await tagOf(aliceRo);
  const again = await get(aliceRo, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("assign, retitle, close and unassign each move the tag", async () => {
  const issue = open("first");
  let tag = await tagOf(aliceRo);
  expect((await assign(issue.number, "alice")).status).toBe(200);
  tag = await moved(aliceRo, tag);
  const again = await get(aliceRo, { "if-none-match": tag });
  expect(again.status).toBe(304);

  expect(updateIssueText(app.db, issue.id, { title: "renamed" }).ok).toBe(true);
  tag = await moved(aliceRo, tag);

  const second = open("second");
  expect((await assign(second.number, "alice")).status).toBe(200);
  tag = await moved(aliceRo, tag);
  expect((await assign(second.number, null)).status).toBe(200);
  tag = await moved(aliceRo, tag);

  setIssueState(app.db, issue.id, "closed");
  await moved(aliceRo, tag);
});

test("two users never share a tag for different lists", async () => {
  const issue = open("mine");
  expect((await assign(issue.number, "alice")).status).toBe(200);
  const a = await tagOf(aliceRo);
  const b = await tagOf(bobTok);
  expect(a).not.toBe(b);
  const cross = await get(bobTok, { "if-none-match": a });
  expect(cross.status).toBe(200);
  await cross.text();
});

test("no session, or a token short of ro, is as today with no tag", async () => {
  const anon = await get(null, { "if-none-match": "*" });
  expect(anon.status).toBe(401);
  expect(anon.headers.get("etag")).toBeNull();
  await anon.text();
  // A scope above ro still reads (and is tagged); a bad credential is refused.
  const rw = await get(aliceWrite);
  expect(rw.status).toBe(200);
  await rw.text();
  const bad = await get("not-a-token", { "if-none-match": "*" });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("etag")).toBeNull();
  await bad.text();
});
