/** Settings › Passkeys is drawn as the home page draws a block: headings over rows, no boxes (#9726). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addPasskey } from "../src/core/passkeys.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pkpage-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
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

const main = async () => {
  const text = await (await fetch(`${servers.url}/settings/passkeys`, { headers: { authorization: `Bearer ${bearer}` } })).text();
  return text.slice(text.indexOf("<main"), text.indexOf("</main>"));
};

test("with none, the page says so in a sentence, not an empty-state box", async () => {
  const page = await main();
  expect(page).toContain("No passkeys yet.");
  expect(page).not.toContain('class="card empty"');
  expect(page).toContain('id="passkey-add"');
});

test("each passkey is a row with when it was added and used, and its own Remove", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const added = addPasskey(app.db, alice.id, "Work <laptop>", { id: "cred-page", alg: "ES256", key: { kty: "EC", crv: "P-256", x: "x", y: "y" }, signCount: 0 });
  if (!added.ok) throw new Error(added.error);
  const page = await main();
  expect(page).toContain('<ul class="list setting-list" id="passkeys">');
  expect(page).toContain('class="row-title"');
  expect(page).toContain("never used");
  expect(page).toContain('aria-label="Remove Work &lt;laptop&gt;"');
  expect(page).not.toContain("Work <laptop>");
  expect(page).toContain(`/-/confirm?to=${encodeURIComponent(`/settings/passkeys/${added.value}/delete`)}`);
  expect(page).toContain("<h2>Your passkeys</h2>");
  expect(page).toContain("<h2>New passkey</h2>");
  for (const boxed of ['class="card', "<table", 'class="table-scroll"']) expect(page).not.toContain(boxed);
});
