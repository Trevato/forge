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
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
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
  expect(form).toContain('action="/forges/start"');
  expect(form).toMatch(/method="post"/i);
  expect(form).toMatch(/<label[^>]*for="start-name"/);
  expect(form).toContain('id="start-name"');
  expect(form).toContain("required");
  expect(form).toContain("Start my forge");
  expect(body).toContain("free to try");
  expect(form).toContain('autocapitalize="none"');
  expect(form).toContain('autocomplete="off"');
  expect(form).not.toContain("class=\"hint\"");
  expect(body.match(/Start my forge\s*<\/button>/g)).toHaveLength(1);
});

test("the first view has one primary button, and the first sentence is one", async () => {
  const body = await (await fetch(`${servers.url}/`)).text();
  const hero = body.slice(body.indexOf('class="door-hero"'), body.indexOf('id="made"'));
  expect(hero.match(/data-variant="primary"/g)).toHaveLength(1);
  expect(hero.match(/class="door-support"/g)).toHaveLength(1);
});

test("the form's POST without a same-origin header is refused by the door", async () => {
  const res = await fetch(`${servers.url}/forges/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: "name=sneaky",
    redirect: "manual",
  });
  expect([400, 403]).toContain(res.status);
});

test("the plans button goes to the start form, not to /forges/new", async () => {
  const body = await (await fetch(`${servers.url}/`)).text();
  const section = body.slice(body.indexOf('id="yours"'));
  expect(section).toContain('href="#start-forge"');
  expect(body).toContain('id="start-name-says"');
});

test("starting answers the page that says the forge is starting and holds its link", async () => {
  const res = await fetch(`${servers.url}/forges/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: "name=Sunny-Day",
  });
  const body = await res.text();
  if (res.status >= 400) throw new Error(`refused ${res.status}: ${body.slice(0, 300)}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(body).toContain("sunny-day is made and is starting. This usually takes about 15 seconds.");
  expect(body).toMatch(/id="made-open"[^>]*>\s*Open sunny-day|Open sunny-day/);
  expect(body).toMatch(/href="[^"]*sunny-day--[^"]*\/welcome#[A-Za-z0-9_-]{43}"/);
  // Their own forge: nothing to send, no "What it is for", no apps to fork on this path.
  expect(body).not.toContain("Send this link");
  expect(body).not.toContain("What it is for");
  expect(body).not.toContain("Apps to fork");
});

// ---- a refused start says why on `/` (#11238) ----

let refusal: { reason: "exists" | "quota"; message: string } | undefined;
const start = (name: string) =>
  fetch(`${servers.url}/forges/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name }),
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
  useProbe(app, () => async () => false); // every forge started here is still booting: a 200 waiting page, then the 303 refusal
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

// ---- the page's scripts, run against a stand-in document (#11281) ----

type Fake = { value: string; textContent: string; attrs: Record<string, string>; on: Record<string, () => void> };
const fake = (attrs: Record<string, string> = {}, value = ""): Fake => ({ value, textContent: "", attrs, on: {} });

/** Runs a page script with fake elements, a scripted fetch and instant timers; returns what it asked for. */
function runScript(js: string, els: Record<string, Fake>, answer: (url: string) => { status: number; json?: unknown } | "fail") {
  const asked: string[] = [];
  const doc = {
    getElementById: (id: string) =>
      els[id] === undefined
        ? null
        : Object.assign(els[id], {
            addEventListener: (ev: string, fn: () => void) => (els[id]!.on[ev] = fn),
            getAttribute: (k: string) => els[id]!.attrs[k],
          }),
  };
  const gone: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g["window"], fetch: g["fetch"], location: g["location"], setTimeout: g["setTimeout"] };
  g["window"] = { fetch: true };
  g["location"] = { replace: (u: string) => gone.push(u) };
  g["fetch"] = (url: string) => {
    asked.push(url);
    const a = answer(url);
    return a === "fail" ? Promise.reject(new Error("down")) : Promise.resolve({ status: a.status, json: () => Promise.resolve(a.json) });
  };
  g["setTimeout"] = (fn: () => void) => queueMicrotask(fn);
  const restore = () => Object.assign(g, saved);
  new Function("document", `return ${js.replace(/\(document\);?\s*$/, "")}`)(doc)(doc);
  return { asked, gone, restore };
}
const settle = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve();
};

test("the live check: free, taken and why read in words, a 429 reads nothing, a bad name never asks", async () => {
  const { startNameJs } = await import("../src/web/pages/start-forge.ts");
  const input = fake({}, "Sunny-Day");
  const says = fake();
  const run = runScript(startNameJs, { "start-name": input, "start-name-says": says }, (u) => ({
    status: u.includes("rate") ? 429 : 200,
    json: { verdict: u.includes("sunny-day") ? "free" : u.includes("admin") ? "reserved" : "taken", why: "admin can't be used as a name." },
  }));
  try {
    input.on["input"]!();
    await settle();
    expect(run.asked).toEqual(["/forges/name/sunny-day"]);
    expect(startNameJs).not.toContain("/ready");
    expect(says.textContent).toBe("sunny-day is free.");
    input.value = "taken";
    input.on["input"]!();
    await settle();
    expect(says.textContent).toBe("taken is taken. Try another.");
    input.value = "admin";
    input.on["input"]!();
    await settle();
    expect(says.textContent).toBe("admin can't be used as a name.");
    input.value = "rate";
    input.on["input"]!();
    await settle();
    expect(says.textContent).toBe("admin can't be used as a name.");
    input.value = "No Good!";
    input.on["input"]!();
    expect(says.textContent).toBe("Use lowercase letters, digits and dashes.");
    expect(run.asked.length).toBe(4);
    input.value = "";
    input.on["input"]!();
    expect(says.textContent).toBe("");
  } finally {
    run.restore();
  }
});

// ---- a signed-in poster goes to the fuller form, with a checked name only ----

test("a signed-in start redirects to /forges/new, keeping only a valid name", async () => {
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "ann", allowReserved: true, email: "ann@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  const cookie = `forge_session=${createSession(app.db, r.value.id).token}`;
  const post = async (name: string) => {
    const res = await fetch(`${servers.url}/forges/start`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url, cookie },
      body: `name=${encodeURIComponent(name)}`,
    });
    return res.headers.get("location") ?? "";
  };
  expect(await post("Sunny-Day")).toBe("/forges/new?name=sunny-day");
  expect(await post('"><script>')).toBe("/forges/new");
  expect(await post("-bad-")).toBe("/forges/new");
  expect(await post("a".repeat(60))).toBe("/forges/new");
});
