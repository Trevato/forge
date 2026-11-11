/** The bets list joins the shell's j/k row traversal (#10403): one data-nav per linked row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { insertBet, markBacked } from "../src/core/bets.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-bets-"));
  app = createApp({ dataDir, port: 0, forgeRepo: "acme/forge" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app, made.value, { name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  repoId = repo.value.id;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async () => (await fetch(`${servers.url}/alice/notes/bets`, { headers: { cookie } })).text();
const navRows = (text: string) => text.split("<li").filter((li) => /class="row"[^>]*data-nav tabindex="-1"/.test(li));

test("the empty bets page draws no data-nav row", async () => {
  const text = await get();
  expect(text).toContain("No bets yet.");
  expect(text).not.toMatch(/class="row"[^>]*data-nav tabindex="-1"/);
});

test("each bet, proposed or running, is one data-nav row whose first link opens it", async () => {
  const now = new Date();
  const a = insertBet(app.db, { repoId, name: "Alpha", journeys: "one", appetite: 10, leadId: null, issueIds: [] }, now);
  const b = insertBet(app.db, { repoId, name: "Bravo", journeys: "two", appetite: 20, leadId: null, issueIds: [] }, now);
  insertBet(app.db, { repoId, name: "Charlie", journeys: "three", appetite: 30, leadId: null, issueIds: [] }, now);
  markBacked(app.db, b.id, 20, "owner", now);
  const rows = navRows(await get());
  expect(rows.length).toBe(3);
  for (const id of [a.id, b.id]) {
    const one = rows.find((r) => r.includes(`/alice/notes/bets/${id}`))!;
    expect(one.match(/<a href="([^"]+)"/)![1]).toBe(`/alice/notes/bets/${id}`);
  }
});
