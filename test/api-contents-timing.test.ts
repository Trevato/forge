/** `GET /api/v1/repos/:o/:n/contents` names session, git and render in Server-Timing (#3781). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { tokenFor } from "./helpers/tokens.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let headers: Record<string, string> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-contents-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "mira", email: "mira@f.dev", password: "contents-timing-pass" });
  headers = { authorization: `Bearer ${tokenFor(app, "mira", "rw")}`, "content-type": "application/json" };
  const base = `${servers.url}/api/v1/repos`;
  await fetch(base, { method: "POST", headers, body: JSON.stringify({ name: "app", visibility: "public" }) });
  const res = await fetch(`${base}/mira/app/contents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "initial", files: [{ path: "src/a.txt", content: "hi\n" }] }),
  });
  expect(res.status).toBe(201);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const phases = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
const get = (path: string) => fetch(`${servers.url}/api/v1/repos/mira/app/contents${path}`, { headers });

test("a directory names session, git and render once each", async () => {
  const res = await get("/src");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { type: string }).type).toBe("dir");
  const names = phases(res);
  for (const n of ["session", "git", "render"]) expect(names.filter((x) => x === n)).toHaveLength(1);
});

test("a file names session, git and render once each", async () => {
  const res = await get("/src/a.txt");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { content: string }).content).toBe("hi\n");
  const names = phases(res);
  for (const n of ["session", "git", "render"]) expect(names.filter((x) => x === n)).toHaveLength(1);
});

test("a 404 still names session", async () => {
  const res = await get("/nope.txt");
  expect(res.status).toBe(404);
  expect(phases(res)).toContain("session");
  const unknown = await fetch(`${servers.url}/api/v1/repos/mira/none/contents`, { headers });
  expect(unknown.status).toBe(404);
  expect(phases(unknown)).toContain("session");
});
