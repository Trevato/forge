/** `here` carries the Plan row's words and billing link for this forge's admin, on `/` and `/settings`, and for no one else. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { planLine } from "../src/web/plan_row.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", member = "";
let id = 1;
const PORTAL = "https://billing.example.com/p/login/abc";

const here = async (token: string, args: unknown): Promise<any> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "here", arguments: args } }),
  });
  const body: any = await res.json();
  return JSON.parse(body.result.content[0].text);
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-here-plan-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  promote(app.db, b.value);
  admin = tokenFor(app, "alice", "rw");
  member = tokenFor(app, "bob", "rw");
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a forge with no plan notice has no plan key, even for its admin", async () => {
  expect((await here(admin, { url: "/settings" })).plan).toBeUndefined();
});

test("the admin reads the plan on /settings and with no page; a non-admin gets none", async () => {
  await writeFile(join(dataDir, "plan.json"), JSON.stringify({ name: "Medium", size: "medium", priceUsd: 49, creditUsd: 10, status: "active", portalUrl: PORTAL }));
  const text = planLine(dataDir)!;
  expect(text).toContain("Medium");
  for (const args of [{ url: "/settings" }, {}, { url: "/" }]) {
    expect((await here(admin, args)).plan).toEqual({ text, manage: PORTAL });
    expect((await here(member, args)).plan).toBeUndefined();
  }
  expect((await here(admin, { url: "/explore" })).plan).toBeUndefined();
});

test("no portal address, no manage key", async () => {
  await writeFile(join(dataDir, "plan.json"), JSON.stringify({ name: "Small", size: "small", priceUsd: 9, creditUsd: 0, status: "active" }));
  const plan = (await here(admin, {})).plan;
  expect(plan.text).toContain("Small");
  expect("manage" in plan).toBe(false);
});
