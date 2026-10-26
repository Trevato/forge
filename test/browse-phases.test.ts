import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { clearViewCache } from "../src/view/cache.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { fastFirstFetch } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";

/** Browsing an origin names where the time went: session, origin, render. */

const TOKEN = "octo-origin-secret-4b81";
const PASSWORD = "alice-login-secret";
const auth = `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`;

fastFirstFetch();

describe("browsing an origin: Server-Timing", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let root = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-browse-timing-"));
    const state = newFakeState("forgejo", "octo", TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      cloneUrl: "http://127.0.0.1:1/octo/widgets.git",
      defaultBranch: "main",
    });
    state.files.set("octo/widgets", new Map([["README.md", "# widgets\n"]]));
    state.branches.set("octo/widgets", [{ name: "main", sha: "a".repeat(40), protected: false }]);
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        user: "mona",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    fake = serveFakeForge(state);
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    const connected = await fetch(`${servers.url}/api/v1/user/origins`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ host: fake.url, token: TOKEN }),
    });
    expect(connected.status).toBe(201);
    const id = ((await connected.json()) as { id: string }).id;
    root = `${servers.url}/api/v1/user/origins/${id}/browse/octo/widgets`;
    clearViewCache();
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  });

  const phases = (response: Response): string[] =>
    (response.headers.get("server-timing") ?? "")
      .split(",")
      .map((part) => part.trim().split(/[;=]/)[0]!)
      .filter(Boolean);

  for (const path of ["", "/branches", "/blob/main/README.md", "/issues"]) {
    test(`GET …/browse/octo/widgets${path} names session, origin and render`, async () => {
      const response = await fetch(`${root}${path}`, { headers: { authorization: auth } });
      expect(response.status).toBe(200);
      const names = phases(response);
      for (const name of ["session", "origin", "render"]) expect(names).toContain(name);
    });
  }
});
