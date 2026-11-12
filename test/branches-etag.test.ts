/** GET …/branches carries an ETag over every ref; a repeat is 304 until a ref moves (#9157). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repo: Repo;
let alice: User;
const cells = process.env["FORGE_CELLS"];

const commit = async (branch: string | undefined, file: string, content: string) => {
  const done = await commitToBranch(app, alice, repo, {
    ...(branch === undefined ? {} : { branch }),
    message: "change",
    files: [{ path: file, content }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-branches-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const r = await createRepo(app, alice, { name: "r", visibility: "private" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  await commit(undefined, "forge.json", "{}");
  await commit("topic", "t.txt", "x");
}, 120_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const URL_ = "/api/v1/repos/alice/r/branches";
const get = (query = "", tag?: string, c: string | undefined = cookie) =>
  fetch(`${servers.url}${URL_}${query}`, {
    headers: { ...(c ? { cookie: c } : {}), ...(tag === undefined ? {} : { "if-none-match": tag }) },
  });
const tagOf = async (query = "") => {
  const res = await get(query);
  await res.text();
  return res.headers.get("etag")!;
};

test("200 carries a weak tag and private headers; a repeat is an empty 304", async () => {
  const first = await get();
  expect(first.status).toBe(200);
  const tag = first.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  expect(first.headers.get("vary")).toContain("authorization, cookie");
  await first.text();
  expect(first.headers.get("server-timing") ?? "").toContain("compare");
  const again = await get("", tag);
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(await again.text()).toBe("");
  expect(again.headers.get("server-timing") ?? "").not.toContain("compare");
});

test("a push to a branch, to the default, a new branch and a deleted branch each change the tag", async () => {
  let tag = await tagOf();
  await commit("topic", "t2.txt", "y");
  let next = await tagOf();
  expect(next).not.toBe(tag);
  tag = next;
  // The page lists only one row, yet the default's move still changes it.
  const limited = await tagOf("?limit=1");
  await commit(undefined, "m.txt", "z");
  expect(await tagOf("?limit=1")).not.toBe(limited);
  tag = await tagOf();
  await commit("extra", "e.txt", "e");
  next = await tagOf();
  expect(next).not.toBe(tag);
  tag = next;
  const del = await fetch(`${servers.url}${URL_}/extra`, { method: "DELETE", headers: { cookie, origin: servers.url } });
  expect(del.status).toBeLessThan(300);
  const stale = await get("", tag);
  expect(stale.status).toBe(200);
  expect(stale.headers.get("etag")).not.toBe(tag);
  await stale.text();
});

test("limit and cursor tag their own page", async () => {
  const all = await tagOf();
  const one = await tagOf("?limit=1");
  const after = await tagOf("?limit=1&cursor=main");
  expect(new Set([all, one, after]).size).toBe(3);
});

test("a bad limit or cursor is a 422 and an unseen repository a 404, none tagged", async () => {
  for (const q of ["?limit=0", "?limit=x", "?cursor=nope", "?cursor="]) {
    const res = await get(q, "*");
    expect(res.status).toBe(422);
    expect(res.headers.get("etag")).toBeNull();
    await res.text();
  }
  const hidden = await get("", "*", "");
  expect(hidden.status).toBe(404);
  expect(hidden.headers.get("etag")).toBeNull();
  await hidden.text();
});
