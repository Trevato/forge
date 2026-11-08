/** Settings › Telemetry is headings over rows, not cards (#9806). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { setTelemetryGrant } from "../src/actions/telemetry.ts";
import { createApp, type App } from "../src/app.ts";
import { logRead } from "../src/core/telemetry.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";

async function page(): Promise<string> {
  const html = await (await fetch(`${servers.url}/settings/telemetry`, { headers: { cookie } })).text();
  return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-telemetry-blocks-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("with no agents and no reads, each heading has one plain sentence and no box", async () => {
  const main = await page();
  for (const h of ["Telemetry grants", "Reads"]) expect(main).toContain(`<h2>${h}</h2>`);
  expect(main).toContain("No agent accounts yet.");
  expect(main).toContain("No agent has read anything yet.");
  for (const boxed of ['class="card', "card-head", "card-body", 'class="empty']) expect(main).not.toContain(boxed);
});

test("one granted agent and one read: two headed sections, a Revoke row, no card", async () => {
  const made = await createAgent(app, alice, { username: "muse" });
  if (!made.ok) throw new Error(String(made.error));
  expect(setTelemetryGrant(app, alice, "muse", true).ok).toBe(true);
  logRead(app.db, made.value.user.id, "/api/v1/telemetry/<flow>");
  const main = await page();
  const grants = main.slice(main.indexOf("<h2>Telemetry grants</h2>"));
  const grantsBlock = grants.slice(0, grants.indexOf("</section>"));
  expect(main.lastIndexOf('<section class="settings-block">', main.indexOf("<h2>Telemetry grants</h2>"))).toBeGreaterThan(-1);
  expect(grantsBlock).toContain('<ul class="list setting-list">');
  expect(grantsBlock).toContain("Revoke");
  expect(grantsBlock).toContain('action="/settings/telemetry"');
  const reads = main.slice(main.indexOf("<h2>Reads</h2>"));
  const readsBlock = reads.slice(0, reads.indexOf("</section>"));
  expect(main.indexOf("<h2>Reads</h2>")).toBeGreaterThan(-1);
  expect(readsBlock).toContain("muse");
  expect(readsBlock).toContain("/api/v1/telemetry/&lt;flow&gt;");
  expect(readsBlock).not.toContain("<flow>");
  for (const boxed of ['class="card', "card-head", "card-body"]) expect(main).not.toContain(boxed);
});
