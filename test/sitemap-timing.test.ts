/** /sitemap.xml names its Server-Timing phases: the read and the XML. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sitemap-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  for (const [name, visibility] of [["one", "public"], ["two", "public"], ["hidden", "private"]] as const) {
    const r = await createRepo(app, a.value, { name, visibility });
    if (!r.ok) throw new Error(String(r.error));
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the sitemap names repos and render, and lists only the public repositories", async () => {
  const res = await fetch(`${servers.url}/sitemap.xml`);
  expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  const timing = res.headers.get("server-timing") ?? "";
  expect(timing).toContain("repos;dur=");
  expect(timing).toContain("render;dur=");
  const body = await res.text();
  expect(body).toContain("/alice/one</loc>");
  expect(body).toContain("/alice/two</loc>");
  expect(body).not.toContain("hidden");
});
