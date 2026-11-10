/** The flags list joins the shell's j/k row traversal (#10358): one data-nav per row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeFlags } from "../src/core/flags.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-flags-"));
  app = createApp({ dataDir, port: 0, forgeRepo: "acme/forge" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterAll(async () => {
  useFlagRegistry(undefined);
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async () => (await fetch(`${servers.url}/settings/flags`, { headers: { cookie } })).text();

test("each flag row is one data-nav row whose primary link is its owner issue", async () => {
  useFlagRegistry(
    makeFlags({
      one: { why: "first", default: false, issue: 11 },
      two: { why: "second", default: false, issue: 12 },
      three: { why: "third", default: true, issue: 13 },
    }),
  );
  const text = await get();
  const rows = text.split("<li").filter((li) => /class="row"[^>]*data-nav tabindex="-1"/.test(li));
  expect(rows.length).toBe(3);
  for (const [i, n] of [11, 12, 13].entries()) {
    expect(rows[i]).toContain(`href="/acme/forge/issues/${n}"`);
    // the first link in the row is the one enter opens
    expect(rows[i]!.match(/<a href="([^"]+)"/)![1]).toBe(`/acme/forge/issues/${n}`);
  }
  // the settings sidebar's own data-nav rows are not nested in a flag row
  expect(rows.every((r) => !r.includes("<li"))).toBe(true);
});

test("the empty list draws no flag data-nav row", async () => {
  useFlagRegistry(makeFlags({}));
  const text = await get();
  expect(text).toContain("No flag is declared yet.");
  expect(text).not.toMatch(/class="row"[^>]*data-nav tabindex="-1"/);
});
