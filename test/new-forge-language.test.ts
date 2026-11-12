/** /forges/new speaks the home page's language: headed sections, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { ok } from "../src/kernel/result.ts";
import { setLimit } from "../src/settings/limits.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let auth: Record<string, string> = {};
let roomLeft = true;
const spawned: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-newforge-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  useProbe(app, () => async () => true);
  usePlacement(app, {
    place: async (plan: { name: string }) => ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${plan.name}` }),
    retire: async () => ok(),
    room: () => (roomLeft ? undefined : { message: "the test host is full" }),
  } as never);
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  auth = { authorization: `Bearer ${createToken(app.db, made.value.id, "t", "admin").token}` };
});
afterAll(async () => {
  for (const name of spawned) await bootHostedChild(app, name);
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const boxed = ['class="card', "card-body"];

test("the hosting line says the crew starts on the included credit only when there is some", async () => {
  const say = async () => {
    const page = main(await (await fetch(servers.url + "/forges/new", { headers: auth })).text());
    const line = /<p class="muted small" id="hosting-terms">([^]*?)<\/p>/.exec(page)?.[1] ?? "";
    expect(line.split("Free within limits").length - 1).toBe(1);
    return line;
  };
  const id = app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id;
  setLimit(app.db, "spawn.included_credit_usd", 3, id);
  expect(await say()).toBe(
    "Free within limits: it sleeps when idle, and its crew starts on the included $3 of credit, and you can add your AI account key later.",
  );
  setLimit(app.db, "spawn.included_credit_usd", 0, id);
  expect(await say()).toBe(
    "Free within limits: it sleeps when idle, and its crew starts once you add your AI account.",
  );
});

test("the form is a headed section, not a card", async () => {
  const page = main(await (await fetch(servers.url + "/forges/new", { headers: auth })).text());
  expect(page).toContain('<section class="settings-block">');
  expect(page).toContain("<h2>Its name and apps</h2>");
  for (const b of boxed) expect(page).not.toContain(b);
});

test("the plan is a headed section", async () => {
  const res = await fetch(servers.url + "/forges/new", {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ name: "plan-lang", do: "plan" }),
  });
  const page = main(await res.text());
  expect(page).toContain('<section class="settings-block" id="plan">');
  expect(page).toContain("<h2>The plan</h2>");
  for (const b of boxed) expect(page).not.toContain(b);
});

const spawn = (name: string) =>
  fetch(servers.url + "/forges/new", {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ name }),
  });

test("the answer holds the claim link in a headed section, once, never cached", async () => {
  const res = await spawn("made-lang");
  spawned.push("made-lang");
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const page = main(await res.text());
  expect(page).toContain('<section class="settings-block">');
  expect(page).toContain("<h2>The link to send</h2>");
  expect(page).toContain('id="claim-link"');
  for (const b of boxed) expect(page).not.toContain(b);
});

test("a forge that already exists says its link is not shown again", async () => {
  const res = await spawn("made-lang");
  expect(res.status).toBe(200);
  const page = main(await res.text());
  expect(page).toContain("<h2>Its link</h2>");
  expect(page).toContain("made-lang already exists");
  expect(page).not.toContain('id="claim-link"');
  for (const b of boxed) expect(page).not.toContain(b);
});

test("with no room, one headed section says so and there is no form", async () => {
  roomLeft = false;
  try {
    const page = main(await (await fetch(servers.url + "/forges/new", { headers: auth })).text());
    expect(page).toContain("<h2>No room</h2>");
    expect(page).toContain("the test host is full");
    expect(page).not.toContain('id="new-forge"');
    for (const b of boxed) expect(page).not.toContain(b);
  } finally {
    roomLeft = true;
  }
});
