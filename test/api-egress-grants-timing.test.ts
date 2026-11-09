/** The API's egress grants read names its Server-Timing phases (#3938). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-egress-timing-"));
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
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const done = await commitToBranch(app, alice, repo.value, {
    message: "change",
    files: [
      {
        path: "forge.json",
        content: JSON.stringify({
          app: { run: "bun run src/server.ts" },
          egress: ["100.89.95.68:8101"],
        }),
      },
    ],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(
  path: string,
  headers: Record<string, string> = { cookie },
): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the egress grants read names session, grants and render in order", async () => {
  const got = await phases("/api/v1/repos/alice/r/egress-grants");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "grants", "render"]);
  expect(JSON.parse(got.body).next_cursor).toBeNull();
});

test("a missing repository still names session", async () => {
  const got = await phases("/api/v1/repos/alice/nope/egress-grants");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session"]);
});

test("an anonymous read is refused and names session", async () => {
  const got = await phases("/api/v1/repos/alice/r/egress-grants", {});
  expect(got.status).toBe(401);
  expect(got.names).toEqual(["session"]);
});
