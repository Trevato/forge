/** The anonymous home offers one way in: a labelled name field and "Start my forge" (#11237). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { err, ok } from "../src/kernel/result.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { resetAnonSpawns } from "../src/spawn/rate.ts";
import { START_REFUSALS } from "../src/web/start_refusal.ts";

let dataDir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-start-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a visitor with no cookies sees the start form on /", async () => {
  const body = await (await fetch(`${servers.url}/`)).text();
  const form = body.match(/<form[^>]*id="start-forge"[\s\S]*?<\/form>/)?.[0] ?? "";
  expect(form).toContain('action="/forges/new"');
  expect(form).toMatch(/method="post"/i);
  expect(form).toMatch(/<label[^>]*for="start-name"/);
  expect(form).toContain('id="start-name"');
  expect(form).toContain("required");
  expect(form).toContain("Start my forge");
  expect(body).toContain("free to try");
  expect(form).toContain('autocapitalize="none"');
  expect(form).toContain('autocomplete="off"');
  expect(form).not.toContain("class=\"hint\"");
  expect(body.match(/Start my forge/g)).toHaveLength(1);
});

test("the first view has one primary button, and the first sentence is one", async () => {
  const body = await (await fetch(`${servers.url}/`)).text();
  const hero = body.slice(body.indexOf('class="door-hero"'), body.indexOf('id="made"'));
  expect(hero.match(/data-variant="primary"/g)).toHaveLength(1);
  expect(hero.match(/class="door-support"/g)).toHaveLength(1);
});

test("the form's POST without a same-origin header is refused by the door", async () => {
  const res = await fetch(`${servers.url}/forges/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: "name=sneaky",
    redirect: "manual",
  });
  expect([400, 403]).toContain(res.status);
});

// ---- a refused start says why on `/` (#11238) ----

let refusal: { reason: "exists" | "quota"; message: string } | undefined;
const start = (name: string) =>
  fetch(`${servers.url}/forges/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name, from: "home" }),
    redirect: "manual",
  });
/** Follow the refusal to `/` the way a browser does: one redirect, then the page. */
async function landing(name: string): Promise<{ to: string; body: string }> {
  const res = await start(name);
  expect(res.status).toBe(303);
  const to = res.headers.get("location") ?? "";
  expect(to.startsWith("/?start=")).toBe(true);
  return { to, body: await (await fetch(`${servers.url}${to}`)).text() };
}
const sentence = (body: string) => (body.match(/id="start-refused"[^>]*>([^<]*)</)?.[1] ?? "").replaceAll("&#39;", "'");

test("a name the door rejects lands on / with the sentence and the name kept", async () => {
  useProbe(app, () => async () => true);
  const { body } = await landing("Bad_Name");
  expect(sentence(body)).toBe(START_REFUSALS.name);
  expect(body).toContain('value="Bad_Name"');
});

test("a taken name lands on / with the sentence and the name kept", async () => {
  usePlacement(app, {
    place: async (plan) => (refusal ? err(refusal) : ok({ url: `https://${plan.name}.fake.test`, bodyId: "x" })),
    retire: async () => ok(),
  });
  refusal = { reason: "exists", message: "a child named mine already exists" };
  const { body } = await landing("mine");
  expect(sentence(body)).toBe(START_REFUSALS.taken);
  expect(body).toContain('value="mine"');
});

test("no capacity lands on / with the sentence, and no raw message", async () => {
  refusal = { reason: "quota", message: "7 of 7 forges sent on this node — raise the room" };
  const { to, body } = await landing("roomy");
  expect(sentence(body)).toBe(START_REFUSALS.full);
  expect(to).not.toContain("7");
  expect(body).not.toContain("7 of 7");
  expect(body).toContain('value="roomy"');
});

test("the rate limit lands on / with the sentence, and no code or time", async () => {
  refusal = undefined;
  resetAnonSpawns(app.db);
  let last = { to: "", body: "" };
  for (let i = 0; i < 12; i++) {
    const res = await start(`kid-${i}`);
    if (res.status === 303) {
      const to = res.headers.get("location") ?? "";
      last = { to, body: await (await fetch(`${servers.url}${to}`)).text() };
      if (to.startsWith("/?start=rate")) break;
    }
  }
  expect(last.to).toStartWith("/?start=rate");
  expect(sentence(last.body)).toBe(START_REFUSALS.rate);
  expect(last.body).not.toContain("rate_limited");
});

test("the name is escaped and an unknown kind shows nothing", async () => {
  const hostile = await (await fetch(`${servers.url}/?start=name&name=${encodeURIComponent('"><script>alert(1)</script>')}`)).text();
  expect(hostile).not.toContain("<script>alert(1)");
  const unknown = await (await fetch(`${servers.url}/?start=<b>&name=x`)).text();
  expect(unknown).not.toContain('id="start-refused"');
  expect(unknown).not.toContain('value="x"');
});
