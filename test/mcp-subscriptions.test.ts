/** The `subscriptions` tool shows what the pool page shows, and never a token. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { addSubscription, EVERYONE, setBudget, setGrants } from "../src/core/subscriptions.ts";
import { createUser } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let admin = "";
let bob = "";
let id = 1;
let oliveId = "";
const SECRET = "sk-ant-oat01-supersecretvalue-0123456789abcdef";

const call = async (token: string, name: string) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: {} } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result?.content[0].text ?? body.error?.message ?? "";
  return { text, failed: body.error !== undefined || body.result.isError === true };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-subs-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@f.dev", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  promote(app.db, b.value);
  oliveId = a.value.id;
  admin = createToken(app.db, a.value.id, "admin", "admin").token;
  bob = createToken(app.db, b.value.id, "bob", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an admin sees a subscription, scopes and budget, and the token is nowhere", async () => {
  const added = addSubscription(app.db, dir, { name: "work", token: SECRET });
  if (!added.ok) throw new Error(String(added.error));
  expect(setBudget(app.db, added.value.id, 12.5)).toBe(true);
  setGrants(app.db, oliveId, EVERYONE, [added.value.id]);

  const res = await call(admin, "subscriptions");
  expect(res.failed).toBe(false);
  expect(res.text).not.toContain(SECRET);
  expect(res.text).not.toContain("supersecretvalue");
  const item = JSON.parse(res.text).items.find((i: { name: string }) => i.name === "work");
  expect(item.id).toBe(added.value.id);
  expect(item.spentUsd).toBe(0);
  expect(item.restingUntil).toBeNull();
  expect(item.budgetUsd).toBe(12.5);
  expect(item.scopes).toEqual(["@olive"]);
});

test("a non-admin is refused", async () => {
  const res = await call(bob, "subscriptions");
  expect(res.failed).toBe(true);
  expect(res.text).not.toContain("work");
});
