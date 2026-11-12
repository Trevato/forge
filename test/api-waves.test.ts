/** The API's waves reads (#5363): newest first, one wave, 404s, and Server-Timing phases. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { writeWave, type Wave } from "../src/story/wave.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mergedPull, waveNaming } from "./helpers/wave-pulls.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let bobCookie = "";
let shown = 0;
let secret = 0;
const cells = process.env["FORGE_CELLS"];

const wave = (version: string, date: string, headline: string): Wave => ({
  version,
  date,
  headline,
  highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: `because ${n}` })),
  pulls: [{ title: "#12 A pull", url: "https://forge.example/o/r/pulls/12" }],
});
const text = (w: Wave): string => {
  const r = writeWave(w);
  if (!r.ok) throw r.error;
  return r.value;
};
const files = [
  wave("0.9.0", "2026-01-01", "Ninth"),
  wave("0.10.0", "2026-02-01", "Tenth"),
].map((w) => ({ path: `waves/${w.version}.md`, content: text(w) }));

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-waves-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(String(bob.error));
  bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  for (const [name, visibility] of [["pub", "public"], ["priv", "private"]] as const) {
    const repo = await createRepo(app, alice, { name, visibility });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, alice, repo.value, { message: "waves", files });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  const repos = new Map<string, Repo>();
  for (const [name, visibility] of [["mix", "public"], ["hid", "private"]] as const) {
    const r = await createRepo(app, alice, { name, visibility });
    if (!r.ok) throw new Error(String(r.error));
    const c = await commitToBranch(app, alice, r.value, {
      message: "init",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    repos.set(name, r.value);
  }
  shown = await mergedPull(app, alice, repos.get("mix")!, "Shown work");
  secret = await mergedPull(app, alice, repos.get("hid")!, "Secret work");
  const c = await commitToBranch(app, alice, repos.get("mix")!, {
    message: "wave",
    files: [
      {
        path: "waves/0.1.0.md",
        content: waveNaming("0.1.0", [
          { owner: "alice", name: "mix", number: shown },
          { owner: "alice", name: "hid", number: secret },
        ]),
      },
    ],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function get(path: string, withCookie: boolean | string = true) {
  const res = await fetch(`${servers.url}${path}`, {
    headers: withCookie === false ? {} : { cookie: withCookie === true ? cookie : withCookie },
  });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the list is newest first by version, not by name", async () => {
  const got = await get("/api/v1/repos/alice/pub/waves");
  expect(got.status).toBe(200);
  expect(JSON.parse(got.body)).toEqual({
    items: [
      { version: "0.10.0", date: "2026-02-01", headline: "Tenth", pulls: 0, apps: 0 },
      { version: "0.9.0", date: "2026-01-01", headline: "Ninth", pulls: 0, apps: 0 },
    ],
    next_cursor: null,
  });
});

test("one wave carries highlights with their why, and its pull numbers", async () => {
  const got = await get("/api/v1/repos/alice/pub/waves/0.9.0");
  expect(got.status).toBe(200);
  const w = JSON.parse(got.body);
  expect(w.headline).toBe("Ninth");
  expect(w.highlights[0]).toEqual({ title: "Thing 1", why: "because 1" });
  expect(w.pulls).toEqual([]);
});

test("a wave's pulls are the page's: the owner sees the private one, an outsider does not", async () => {
  const owner = JSON.parse((await get("/api/v1/repos/alice/mix/waves/0.1.0")).body);
  expect(owner.pulls.map((p: { title: string }) => p.title)).toEqual(["Shown work", "Secret work"]);
  expect(owner.pulls[0]).toMatchObject({ number: shown, state: "merged", merged_at: "2026-03-04T10:00:00.000Z" });
  expect(owner.pulls[0].url).toBe(`${servers.url}/alice/mix/pulls/${shown}`);
  const outsider = await get("/api/v1/repos/alice/mix/waves/0.1.0", bobCookie);
  expect(outsider.status).toBe(200);
  expect(outsider.body).toContain("Shown work");
  expect(outsider.body).not.toContain("Secret work");
  expect(outsider.body).not.toContain("/alice/hid/pulls/");
});

test("the list sizes a wave over the pulls the viewer can see, so hidden ones and apps are not counted", async () => {
  const sizeOf = async (cookie?: string) =>
    JSON.parse((await get("/api/v1/repos/alice/mix/waves", cookie)).body).items.find((i: { version: string }) => i.version === "0.1.0");
  expect(await sizeOf()).toMatchObject({ pulls: 2, apps: 2 });
  expect(await sizeOf(bobCookie)).toMatchObject({ pulls: 1, apps: 1 });
});

test("an unknown or malformed version is 404", async () => {
  for (const v of ["9.9.9", "nope", "1.2", "..%2Fx"])
    expect((await get(`/api/v1/repos/alice/pub/waves/${v}`)).status).toBe(404);
});

test("a stranger gets 404 for a private repository, an owner 200", async () => {
  for (const path of ["waves", "waves/0.9.0"]) {
    expect((await get(`/api/v1/repos/alice/priv/${path}`, false)).status).toBe(404);
    expect((await get(`/api/v1/repos/alice/priv/${path}`)).status).toBe(200);
  }
});

test("the reads name their Server-Timing phases", async () => {
  expect((await get("/api/v1/repos/alice/pub/waves")).names).toEqual(["session", "waves", "render"]);
  expect((await get("/api/v1/repos/alice/pub/waves/0.9.0")).names).toEqual(["session", "wave", "pulls", "render"]);
});
