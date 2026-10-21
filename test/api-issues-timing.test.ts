/** The API's issue list names its phases in Server-Timing (#3771). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-apiissues-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  for (const title of ["one", "two"])
    createIssue(app.db, { repoId: made.value.id, title, body: "b", authorId: admin.value.id });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function names(res: Response): string[] {
  return (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
}

test("the issue list names session, list, labels and render once each", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/issues`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: unknown[] };
  expect(body.items.length).toBe(2);
  for (const n of ["session", "list", "labels", "render"]) expect(names(res).filter((x) => x === n).length).toBe(1);
});

test("an unknown repository's 404 still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/nope/issues`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(404);
  await res.text();
  expect(names(res)).toContain("session");
});
