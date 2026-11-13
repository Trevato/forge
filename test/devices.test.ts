/** A declared LAN printer: validated at the boundary, probed over IPP, shown in one line. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { declareDevice, listDevices, validateDeviceUrl } from "../src/core/devices.ts";
import { decodeResponse, encodeGetPrinterAttributes, probePrinter } from "../src/devices/ipp.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { adminCookie } from "./helpers/admin.ts";

const enc = new TextEncoder();
const attr = (tag: number, name: string, value: string | number) => {
  const n = enc.encode(name);
  const v = typeof value === "number" ? [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255] : [...enc.encode(value)];
  return [tag, n.length >> 8, n.length & 255, ...n, v.length >> 8, v.length & 255, ...v];
};

/** A response as a Brother would send it: model, idle (3), two toners. */
function answer(): Uint8Array {
  return Uint8Array.from([
    1, 1, 0, 0, 0, 0, 0, 1,
    0x01,
    ...attr(0x47, "attributes-charset", "utf-8"),
    0x04,
    ...attr(0x41, "printer-make-and-model", "Brother HL-L2350DW series"),
    ...attr(0x23, "printer-state", 3),
    ...attr(0x44, "printer-state-reasons", "none"),
    ...attr(0x42, "marker-names", "Black Toner"),
    ...attr(0x42, "", "Drum"),
    ...attr(0x21, "marker-levels", 80),
    ...attr(0x21, "", 5),
    0x03,
  ]);
}

let seen: Uint8Array | undefined;
let asked = 0;
const printer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    asked++;
    seen = new Uint8Array(await req.arrayBuffer());
    expect(req.headers.get("content-type")).toBe("application/ipp");
    return new Response(answer(), { headers: { "content-type": "application/ipp" } });
  },
});
const printerUrl = `ipp://127.0.0.1:${printer.port}/ipp/print`;

let dataDir = "";
let app: App, servers: Servers, cookie = "", plain = "";
const priorLoopback = process.env.FORGE_DEVICES_ALLOW_LOOPBACK;
beforeAll(async () => {
  process.env.FORGE_DEVICES_ALLOW_LOOPBACK = "1";
  dataDir = await mkdtemp(join(tmpdir(), "forge-devices-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "correct-horse-battery" });
  if (!bob.ok) throw new Error(bob.error);
  plain = `forge_session=${createSession(app.db, bob.value.id).token}`;
});
afterAll(async () => {
  if (priorLoopback === undefined) delete process.env.FORGE_DEVICES_ALLOW_LOOPBACK;
  else process.env.FORGE_DEVICES_ALLOW_LOOPBACK = priorLoopback;
  printer.stop(true);
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the request is a well-formed Get-Printer-Attributes", () => {
  const b = encodeGetPrinterAttributes("ipp://192.168.1.161:631/ipp/print");
  expect([...b.slice(0, 4)]).toEqual([1, 1, 0, 0x0b]);
  expect(b.at(-1)).toBe(0x03);
  expect(new TextDecoder().decode(b)).toContain("printer-make-and-model");
});

test("a probe reads model, state and supplies", async () => {
  const r = await probePrinter(printerUrl);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.report.model).toBe("Brother HL-L2350DW series");
  expect(r.report.state).toBe("idle");
  expect(r.report.reasons).toEqual([]);
  expect(r.report.supplies.map((s) => [s.name, s.percent])).toEqual([["Black Toner", 80], ["Drum", 5]]);
  expect(new TextDecoder().decode(seen)).toContain("printer-uri");
});

test("garbage and silence are plain failures, not throws", async () => {
  expect(decodeResponse(Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 1, 0x04, 0x41, 0xff]))).toBeUndefined();
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nope") });
  const url = `ipp://127.0.0.1:${dead.port}/ipp/print`;
  const bad = await probePrinter(url);
  dead.stop(true);
  expect(bad).toEqual({ ok: false, error: "bad_answer" });
  expect(await probePrinter(url, 500)).toEqual({ ok: false, error: "unreachable" });
});

test("only private-network IP literals are accepted", () => {
  for (const good of ["ipp://192.168.1.161:631/ipp/print", "ipp://10.0.0.5/ipp/print", "http://172.16.3.4:631/ipp/print", "ipp://[fd00::5]/ipp/print"])
    expect(validateDeviceUrl(good).ok).toBe(true);
  for (const bad of [
    "ipp://8.8.8.8:631/ipp/print",
    "ipp://printer.example.com/ipp/print",
    "ipp://printer.local/ipp/print",
    "ipp://192.168.1.1@8.8.8.8/ipp/print",
    "ipp://[::ffff:8.8.8.8]/ipp/print",
    "ftp://192.168.1.161/x",
    "ipp://192.168.1.161:99999/ipp/print",
    "ipp://192.168.1.161/ipp/print?x=1",
    "ipp://user:pw@192.168.1.161/ipp/print",
    "",
  ])
    expect(validateDeviceUrl(bad).ok).toBe(false);
  expect(validateDeviceUrl("ipp://8.8.8.8/ipp/print")).toEqual({ ok: false, error: "public_address" });
  const taken = declareDevice(app.db, { name: "Dup", kind: "printer", url: printerUrl });
  expect(taken.ok).toBe(true);
  expect(declareDevice(app.db, { name: "Dup", kind: "printer", url: printerUrl })).toEqual({ ok: false, error: "name_taken" });
  expect(declareDevice(app.db, { name: "X", kind: "toaster", url: printerUrl })).toEqual({ ok: false, error: "invalid_kind" });
});

function post(path: string, body: Record<string, string>, who: string | undefined, origin = servers.url) {
  return fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(who ? { cookie: who } : {}) },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

test("the owner declares a printer and the page shows it in one line", async () => {
  const made = await post("/settings/devices", { name: "Hall printer", kind: "printer", url: printerUrl }, cookie);
  expect(made.status).toBe(303);
  const res = await fetch(`${servers.url}/settings/devices`, { headers: { cookie } });
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).toContain("Hall printer");
  expect(text).toContain("Brother HL-L2350DW series · Ready · low: Drum");
  expect(text).toContain("Black Toner");
});

test("an unreachable printer is one plain line", async () => {
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const url = `ipp://127.0.0.1:${dead.port}/ipp/print`;
  dead.stop(true);
  declareDevice(app.db, { name: "Attic", kind: "printer", url });
  const text = await (await fetch(`${servers.url}/settings/devices`, { headers: { cookie } })).text();
  expect(text).toContain("Attic");
  expect(text).toContain("Not reachable right now.");
});

test("a public address is refused at the form, and nothing is stored", async () => {
  const before = listDevices(app.db).length;
  const res = await post("/settings/devices", { name: "Cloud", kind: "printer", url: "ipp://8.8.8.8/ipp/print" }, cookie);
  expect(res.status).toBe(303);
  expect(listDevices(app.db).length).toBe(before);
});

test("only the owner, and only from this origin", async () => {
  const before = listDevices(app.db).length;
  const anon = await post("/settings/devices", { name: "Z", kind: "printer", url: printerUrl }, undefined);
  expect([401, 403, 404, 303]).toContain(anon.status);
  expect(anon.headers.get("location") ?? "").not.toBe("/settings/devices");
  const cross = await post("/settings/devices", { name: "Z", kind: "printer", url: printerUrl }, cookie, "https://evil.example");
  expect(cross.status).toBe(403);
  expect(listDevices(app.db).length).toBe(before);
  expect(await (await fetch(`${servers.url}/settings/devices`)).text()).not.toContain("Printers on your network");
});

test("removing a device removes it", async () => {
  const d = listDevices(app.db).find((x) => x.name === "Attic")!;
  await post("/settings/devices/delete", { id: String(d.id) }, cookie);
  expect(listDevices(app.db).some((x) => x.name === "Attic")).toBe(false);
});

test("a signed-in non-admin sees nothing and can neither declare nor remove", async () => {
  const keep = declareDevice(app.db, { name: "Keep", kind: "printer", url: printerUrl });
  if (!keep.ok) throw new Error(keep.error);
  const before = listDevices(app.db).length;
  const page = await fetch(`${servers.url}/settings/devices`, { headers: { cookie: plain } });
  expect(page.status).toBe(403);
  expect(await page.text()).not.toContain("Keep");
  await post("/settings/devices", { name: "Mine", kind: "printer", url: printerUrl }, plain);
  await post("/settings/devices/delete", { id: String(keep.value.id) }, plain);
  expect(listDevices(app.db).length).toBe(before);
  expect(listDevices(app.db).some((x) => x.name === "Mine")).toBe(false);
});

test("removing refuses another origin", async () => {
  const d = listDevices(app.db).find((x) => x.name === "Keep")!;
  const res = await post("/settings/devices/delete", { id: String(d.id) }, cookie, "https://evil.example");
  expect(res.status).toBe(403);
  expect(listDevices(app.db).some((x) => x.name === "Keep")).toBe(true);
});

test("a second view inside 30 seconds asks the printer nothing", async () => {
  const fresh = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (asked++, new Response(answer(), { headers: { "content-type": "application/ipp" } })) });
  declareDevice(app.db, { name: "Fresh", kind: "printer", url: `ipp://127.0.0.1:${fresh.port}/ipp/print` });
  const view = () => fetch(`${servers.url}/settings/devices`, { headers: { cookie } });
  await view(); // asks every stale printer once
  const afterFirst = asked;
  const text = await (await view()).text();
  fresh.stop(true);
  expect(asked).toBe(afterFirst);
  expect(text).toContain("Fresh");
});

test("link-local (cloud metadata) and the unspecified address are never accepted", () => {
  for (const bad of ["ipp://169.254.169.254/ipp/print", "http://169.254.1.1/x", "ipp://0.0.0.0/ipp/print"])
    expect(validateDeviceUrl(bad)).toEqual({ ok: false, error: "public_address" });
});
