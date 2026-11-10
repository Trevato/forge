/**
 * /system is headings over rows, as the home page is: each part a
 * `<section class="settings-block">` with one <h2>, no `.card`, and the live
 * regions the stream patches keep their ids.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { recordMemory } from "../src/boards/memory.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import type { SystemView } from "../src/system/view.ts";
import { cachesSection, regions, stallSection } from "../src/web/pages/system.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let token = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-system-parts-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  token = createToken(app.db, r.value.id, "t", "admin").token;
  recordMemory(app.db, 120 * 1_048_576, 40 * 1_048_576, Date.now());
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("one <h2> per part, each in a settings-block, and no card", async () => {
  const res = await fetch(servers.url + "/system", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.text();
  const main = body.slice(body.indexOf("<h1>System</h1>"));
  expect(main).not.toMatch(/class="card[ "]/);
  const heads = [...main.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
  expect(heads).toEqual([
    "Machine",
    "Disks and network",
    "Processes",
    "Main-thread stalls, last hour",
    "Telemetry readers",
    "Code page caches, since start",
    "Forge memory",
  ]);
  expect(main.match(/<section class="settings-block"/g)?.length).toBe(heads.length);
  for (const id of ["sys-dup", "summary", "cores", "mem", "temps", "sys-disks", "sys-procs", "sys-stalls", "sys-readers", "sys-caches"]) {
    expect(main).toContain(`id="${id}"`);
  }
  expect(main).toMatch(/<section class="settings-block"><h2>Disks and network<\/h2>\s*<ul class="list" id="sys-disks">/);
  expect(main).not.toContain('<span class="js-only">');
});

const empty: SystemView = {
  at: "",
  seconds: 0,
  cpu: { busyPct: null, cores: [], history: [] },
  temps: [],
  hottestC: null,
  load: null,
  memory: null,
  disks: [],
  net: [],
  io: [],
  processes: 0,
  groups: [],
  duplicates: [],
};

test("an empty view says so in a sentence, in the live regions too", () => {
  const r = regions(empty);
  expect(r["sys-procs"]).toContain("No processes were read.");
  expect(r["sys-procs"]).not.toContain("<table");
  expect(r["sys-disks"]).toContain("No disks or network were read.");
});

test("no stalls says so rather than drawing a header over nothing", () => {
  const h = stallSection([]).text;
  expect(h).toContain("No stalls in the last hour.");
  expect(h).not.toContain("<table");
  expect(stallSection([{ route: "/x", ms: 300, count: 1 }]).text).toContain("<table");
});

test("the caches section keeps no note: the counts' span is in its heading, what each holds is in the `?`", () => {
  expect(cachesSection([]).text).not.toContain("<p ");
});

test("no memory samples yet says so", () => {
  const empty2 = mkdtemp(join(tmpdir(), "forge-system-mem-")).then(async (d) => {
    const a = createApp({ dataDir: d, port: 0 });
    const s = await serve(a);
    const u = await createUser(a.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const t = createToken(a.db, u.value.id, "t", "admin").token;
    const body = await (await fetch(s.url + "/system", { headers: { authorization: `Bearer ${t}` } })).text();
    await s.stop();
    await rm(d, { recursive: true, force: true });
    return body;
  });
  return empty2.then((body) => expect(body).toContain("No samples yet"));
});
