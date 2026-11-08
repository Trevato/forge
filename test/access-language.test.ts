/** Settings › Access speaks the home page's language (#9836): one heading, the filter form, a plain table, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-access-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  for (const [username, first] of [["alice", true], ["bob", false]] as const) {
    await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    const res = await fetch(servers.url + "/signin", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    cookies[username] = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

async function access(query = ""): Promise<string> {
  const res = await fetch(servers.url + "/settings/access" + query, { headers: { cookie: cookies.alice! } });
  expect(res.status).toBe(200);
  return main(await res.text());
}

function plain(page: string): void {
  expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  expect(page).toContain('action="/settings/access"');
  expect(page).toContain('name="ua"');
  expect(page).toContain('name="path"');
}

test("nothing logged for the filter: the filter and the empty sentence, no card", async () => {
  // Signing in is itself logged, so an empty log is reached by a filter that matches nothing.
  const page = await access("?ua=no-such-agent");
  plain(page);
  expect(page).toContain("Nothing in the last day.");
});

test("one logged request: the filter and a table row, escaped, no card", async () => {
  await fetch(servers.url + "/api/v1/lang-probe", { headers: { "user-agent": "<b>probe</b>-bot" } });
  const page = await access();
  plain(page);
  expect(page).toContain("<table");
  expect(page).toContain("/api/v1/lang-probe");
  expect(page).not.toContain("<b>probe</b>");
  expect(page).toContain("&lt;b&gt;probe");
});

test("a non-admin still gets 404", async () => {
  const res = await fetch(servers.url + "/settings/access", { headers: { cookie: cookies.bob! } });
  expect(res.status).toBe(404);
});
