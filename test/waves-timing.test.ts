/** `/:owner/:name/waves` names session, repo, waves and render in Server-Timing (#3282). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { writeWave } from "../src/story/wave.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-waves-timing-"));
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
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  const w = writeWave({
    version: "0.1.0",
    date: "2026-01-01",
    headline: "First",
    highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
    pulls: [{ title: "#1 A pull", url: "https://forge.example/o/r/pulls/1" }],
  });
  if (!w.ok) throw new Error("wave");
  const put = await commitToBranch(app, { id: u.value.id, username: "alice" } as never, made.value, {
    message: "wave",
    files: [{ path: "waves/0.1.0.md", content: w.value }],
  });
  if (!put.ok) throw new Error(JSON.stringify(put.error));
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const phasesOf = (read: string): string[] => ["app", "session", "repo", read, "render"];
const signin = async (): Promise<string> => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const expectPhases = (res: Response, read: string): void => {
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of phasesOf(read))
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
};

test("GET /:owner/:name/waves names its phases, listing waves", async () => {
  const res = await fetch(`${servers.url}/alice/forge/waves`, { headers: { cookie: await signin() } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("First");
  expectPhases(res, "waves");
});

test("GET /:owner/:name/waves/:version names its phases", async () => {
  const res = await fetch(`${servers.url}/alice/forge/waves/0.1.0`, { headers: { cookie: await signin() } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Thing 1");
  expectPhases(res, "wave");
});
