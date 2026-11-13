/** An account's model grant and spend ceilings speak the home page's language (#9897): sections under h2, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-model-lang-"));
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

test("the grant and the ceilings are plain sections under h2, posting where they did", async () => {
  const res = await fetch(servers.url + "/settings/accounts/bob", { headers: { cookie: cookies.alice! } });
  expect(res.status).toBe(200);
  const page = main(await res.text());
  const at = page.indexOf("<h2>Model budget</h2>");
  expect(at).toBeGreaterThan(-1);
  const mine = page.slice(at);
  expect(mine).toContain("<h2>Spend ceilings</h2>");
  expect(mine).toContain('action="/settings/accounts/bob/model"');
  expect(mine).toContain('action="/settings/accounts/bob/ceiling"');
  expect(mine).toContain('name="usd"');
  expect(mine).toContain('name="daily"');
  // Each heading opens a plain section, not a card.
  for (const h of ["<h2>Model budget</h2>", "<h2>Spend ceilings</h2>"])
    expect(page.slice(page.indexOf(h) - 60, page.indexOf(h)).replace(/\s+/g, " ")).toContain('<section class="settings-block">');
  // The grant and ceiling sections hold no card around their forms.
  const grant = page.slice(at, page.indexOf("</section>", at));
  expect(grant).not.toContain("card");
  const ceilingAt = page.indexOf("<h2>Spend ceilings</h2>");
  expect(page.slice(ceilingAt, page.indexOf("</section>", ceilingAt))).not.toContain("card");
});

test("an organization's page is its spend ceilings, a plain section under h2", async () => {
  const founder = getUserByName(app.db, "alice")!;
  expect(createOrg(app.db, "acme", founder.id).ok).toBe(true);
  const res = await fetch(servers.url + "/settings/accounts/acme", { headers: { cookie: cookies.alice! } });
  expect(res.status).toBe(200);
  const page = main(await res.text());
  const at = page.indexOf("<h2>Spend ceilings</h2>");
  expect(at).toBeGreaterThan(-1);
  expect(page.slice(Math.max(0, at - 60), at).replace(/\s+/g, " ")).toContain('<section class="settings-block">');
  expect(page).toContain('action="/settings/accounts/acme/ceiling"');
  expect(page).not.toContain("card");
});

test("a ceiling still posts for an admin only, behind the same-origin check", async () => {
  const body = new URLSearchParams({ daily: "5", perRun: "1" });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const url = servers.url + "/settings/accounts/bob/ceiling";
  const asBob = await fetch(url, {
    method: "POST", redirect: "manual", body, headers: { ...headers, cookie: cookies.bob!, origin: servers.url },
  });
  expect(asBob.status).toBe(403);
  const foreign = await fetch(url, {
    method: "POST", redirect: "manual", body, headers: { ...headers, cookie: cookies.alice!, origin: "https://evil.test" },
  });
  expect(foreign.status).toBeGreaterThanOrEqual(400);
  const ok = await fetch(url, {
    method: "POST", redirect: "manual", body, headers: { ...headers, cookie: cookies.alice!, origin: servers.url },
  });
  expect(ok.status).toBe(303);
});

test("the person's own model page still takes a token and shows none back", async () => {
  const res = await fetch(servers.url + "/settings/model", { headers: { cookie: cookies.bob! } });
  const page = main(await res.text());
  expect(page).toContain("<h2>Your model budget</h2>");
  expect(page).toContain('type="password"');
});
