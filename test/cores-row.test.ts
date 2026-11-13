/** #11694: Settings and the terminal say what a sized forge's cores mean for builds, in the same words. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { allowedCpus, coresLine, coresOf, coresWords, type CoresSource } from "../src/spawn/cores.ts";
import { coresRow } from "../src/web/cores_row.ts";
import { coresScreen, entry } from "../src/tui/screens/cores.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const src = (files: Record<string, string>, env: Record<string, string> = { FORGE_CELL_SIZE: "small", FORGE_CELL_CGROUP_DIR: "/cg" }, machine = 8): CoresSource => ({
  env,
  read: (p) => files[p],
  machine,
});

test("allowedCpus counts a list", () => {
  expect(allowedCpus("Cpus_allowed_list:\t0-3,8\n")).toBe(5);
  expect(allowedCpus("Cpus_allowed_list: 2\n")).toBe(1);
  expect(allowedCpus("nothing")).toBeUndefined();
});

test("how the cores are held is read, not assumed", () => {
  expect(coresOf(src({ "/cg/cpu.max": "100000 100000\n" }))).toEqual({ cpus: 1, hold: "quota" });
  expect(coresOf(src({ "/cg/cpu.max": "max 100000", "/proc/self/status": "Cpus_allowed_list: 3\n" }))).toEqual({ cpus: 1, hold: "affinity" });
  expect(coresOf(src({ "/proc/self/status": "Cpus_allowed_list: 0-7\n" }))).toEqual({ cpus: 1, hold: "watch" });
  expect(coresOf(src({}, {}))).toBeNull();
  expect(coresOf(src({}, { FORGE_CELL_SIZE: "huge" }))).toBeNull();
});

test("one CPU says builds run, slower; the watch's cost is stated", () => {
  expect(coresWords({ cpus: 1, hold: "quota" })).toContain("1 CPU: builds run, slower.");
  expect(coresWords({ cpus: 2, hold: "affinity" })).toStartWith("2 CPUs: builds run.");
  const w = coresWords({ cpus: 1, hold: "watch" });
  expect(w).toContain("Nothing limits this forge to its cores. A build that stays above twice its cores for 5 minutes is stopped; the first 10 minutes are safe.");
});

test("the row is for admins of a sized forge only", () => {
  const line = "1 CPU: builds run, slower.";
  expect(coresRow(true, line)?.toString()).toContain(`<dt>Cores</dt><dd>${line}</dd>`);
  expect(coresRow(false, line)).toBeNull();
  expect(coresRow(true, undefined)).toBeNull();
});

test("the terminal refuses a non-admin: the screen says nothing and run pushes nothing", () => {
  const ctx = { theme: { c: new Proxy({}, { get: () => 0 }) } } as never;
  const texts: string[] = [];
  const member = { user: { isAdmin: false } } as never;
  coresScreen(member, ctx, "1 CPU: builds run.").render({ x: 0, y: 0, w: 100, h: 5 }, { text: (_x: number, _y: number, t: string) => texts.push(t) } as never);
  expect(texts.join(" ")).not.toContain("CPU");
  let pushed = 0;
  entry.run(member, { push: () => pushed++ } as never);
  expect(pushed).toBe(0);
  entry.run({ user: { isAdmin: true } } as never, { push: () => pushed++, theme: { c: {} } } as never);
  expect(pushed).toBe(1);
});

test("the terminal screen prints the row's line", () => {
  const line = coresWords({ cpus: 1, hold: "quota" });
  expect(coresLine(src({ "/cg/cpu.max": "100000 100000" }))).toBe(line);
  const screen = coresScreen({ user: { isAdmin: true } } as never, { theme: { c: new Proxy({}, { get: () => 0 }) } } as never, line);
  const texts: string[] = [];
  screen.render({ x: 0, y: 0, w: 100, h: 5 }, { text: (_x: number, _y: number, t: string) => texts.push(t) } as never);
  expect(texts.join(" ")).toContain("1 CPU: builds run, slower.");
});

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
const saved = process.env["FORGE_CELL_SIZE"];

beforeAll(async () => {
  process.env["FORGE_CELL_SIZE"] = "small";
  dir = await mkdtemp(join(tmpdir(), "forge-cores-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "settings-password" });
}, 60_000);

afterAll(async () => {
  if (saved === undefined) delete process.env["FORGE_CELL_SIZE"];
  else process.env["FORGE_CELL_SIZE"] = saved;
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const settings = async (): Promise<string> => (await fetch(`${servers.url}/settings`, { headers: { cookie } })).text();

test("/settings shows the Cores row for the quota hold and for the watch, in the one dl", async () => {
  const cg = join(dir, "cg");
  await mkdir(cg, { recursive: true });
  process.env["FORGE_CELL_CGROUP_DIR"] = cg;
  await writeFile(join(cg, "cpu.max"), "100000 100000\n");
  const quota = await settings();
  expect(quota).toContain("<dt>Cores</dt>");
  expect(quota).toContain("The kernel holds this forge to its cores");
  await writeFile(join(cg, "cpu.max"), "max 100000\n");
  const open = await settings();
  expect(open).toMatch(/Nothing limits this forge to its cores|pinned to its cores/);
  // One list: the Cores row sits in the dl that holds no second hairline of its own.
  expect(open.match(/<dl class="status-rows"><div class="status-row" data-cores>/g)?.length ?? 0).toBe(1);
  delete process.env["FORGE_CELL_CGROUP_DIR"];
  delete process.env["FORGE_CELL_SIZE"];
  expect(await settings()).not.toContain("<dt>Cores</dt>");
});
