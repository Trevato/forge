/** An app granted a printer prints a PDF through the forge, and reaches nothing else. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mintAppToken, revokeAppToken } from "../src/apps/token.ts";
import { grantDevice, isGranted } from "../src/core/device_grants.ts";
import { declareDevice } from "../src/core/devices.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { PDF_MAX_BYTES, PRINTS_PER_MINUTE, checkPdf, pageCount } from "../src/devices/print.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

const enc = new TextEncoder();
const attr = (tag: number, name: string, value: string | number) => {
  const n = enc.encode(name);
  const v = typeof value === "number" ? [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255] : [...enc.encode(value)];
  return [tag, n.length >> 8, n.length & 255, ...n, v.length >> 8, v.length & 255, ...v];
};

/** A one-page-per-leaf PDF the checker can read. */
const pdf = (pages: number): Uint8Array =>
  enc.encode(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n` +
      Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`).join("") +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );

let received: Uint8Array[] = [];
const printer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    received.push(new Uint8Array(await req.arrayBuffer()));
    return new Response(
      Uint8Array.from([
        1, 1, 0, 0, 0, 0, 0, 1,
        0x01, ...attr(0x47, "attributes-charset", "utf-8"),
        0x02, ...attr(0x21, "job-id", 42), ...attr(0x23, "job-state", 9), ...attr(0x44, "job-state-reasons", "job-completed-successfully"),
        0x03,
      ]),
      { headers: { "content-type": "application/ipp" } },
    );
  },
});

let dataDir = "";
let app: App, servers: Servers, cookie = "";
let deviceId = 0, otherId = 0;
let granted = "", ungranted = "", plainToken = "";
const prior = process.env.FORGE_DEVICES_ALLOW_LOOPBACK;

function addApp(id: string, slug: string): void {
  app.db.run("PRAGMA foreign_keys = OFF");
  app.db.run("INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, 'private')", [id, `repo-${id}`, slug]);
  app.db.run("PRAGMA foreign_keys = ON");
}

beforeAll(async () => {
  process.env.FORGE_DEVICES_ALLOW_LOOPBACK = "1";
  dataDir = await mkdtemp(join(tmpdir(), "forge-print-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const owner = getUserByName(app.db, "alice")!;
  addApp("a1", "labels");
  addApp("a2", "other");
  const url = `ipp://127.0.0.1:${printer.port}/ipp/print`;
  const d = declareDevice(app.db, { name: "Hall", kind: "printer", url });
  const e = declareDevice(app.db, { name: "Attic", kind: "printer", url });
  if (!d.ok || !e.ok) throw new Error("declare");
  deviceId = d.value.id;
  otherId = e.value.id;
  expect(grantDevice(app.db, deviceId, "labels", owner.id).ok).toBe(true);
  granted = mintAppToken(app.db, owner.id, "labels", "production").token;
  ungranted = mintAppToken(app.db, owner.id, "other", "production").token;
  // A person's own token that merely borrows an app's name is not an app.
  plainToken = createToken(app.db, owner.id, "app:labels/production", "ro").token;
});
afterAll(async () => {
  if (prior === undefined) delete process.env.FORGE_DEVICES_ALLOW_LOOPBACK;
  else process.env.FORGE_DEVICES_ALLOW_LOOPBACK = prior;
  printer.stop(true);
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const print = (path: string, token: string | undefined, body: string | Uint8Array) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { connection: "close", "content-type": "application/pdf", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });

test("a granted app prints and gets the job state", async () => {
  received = [];
  const res = await print(`/api/v1/devices/${deviceId}/print`, granted, pdf(2));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ job: { id: 42, state: "completed", reasons: ["job-completed-successfully"] } });
  expect(received.length).toBe(1);
  const sent = received[0]!;
  expect([...sent.slice(0, 4)]).toEqual([1, 1, 0, 2]); // Print-Job
  expect(Buffer.from(sent).toString("latin1")).toContain("application/pdf");
  expect(Buffer.from(sent).toString("latin1")).toContain("%PDF-1.4");
});

test("an app without the grant is 403, and nothing is sent", async () => {
  received = [];
  expect((await print(`/api/v1/devices/${deviceId}/print`, ungranted, pdf(1))).status).toBe(403);
  // Granted one device, not the other.
  expect((await print(`/api/v1/devices/${otherId}/print`, granted, pdf(1))).status).toBe(403);
  // A person's token named like an app is not an app.
  expect((await print(`/api/v1/devices/${deviceId}/print`, plainToken, pdf(1))).status).toBe(403);
  expect((await print(`/api/v1/devices/${deviceId}/print`, undefined, pdf(1))).status).toBe(401);
  expect(received.length).toBe(0);
});

test("a stopped app's token no longer prints", async () => {
  const owner = getUserByName(app.db, "alice")!;
  const t = mintAppToken(app.db, owner.id, "labels", "preview");
  expect((await print(`/api/v1/devices/${deviceId}/print`, t.token, pdf(1))).status).toBe(200);
  revokeAppToken(app.db, t.id);
  expect((await print(`/api/v1/devices/${deviceId}/print`, t.token, pdf(1))).status).toBe(403);
});

test("a non-PDF, an oversize or a long document is 422 and is not sent", async () => {
  received = [];
  const path = `/api/v1/devices/${deviceId}/print`;
  expect((await print(path, granted, "just text")).status).toBe(422);
  expect((await print(path, granted, enc.encode("%PDF-1.4 truncated, no end"))).status).toBe(422);
  expect((await print(path, granted, pdf(21))).status).toBe(422);
  expect((await print(path, granted, pdf(20))).status).toBe(200);
  received = [];
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  big.set(enc.encode("%PDF-1.4\n"));
  const res = await print(path, granted, big);
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: string }).error).toBe("too_large");
  expect(received.length).toBe(0); // the oversize body closes its connection, so it goes last
});

test("a request naming any other address is refused, each with its own status", async () => {
  received = [];
  const lan = encodeURIComponent("ipp://192.168.1.50/ipp/print");
  // Not a device number, or not a declared device: the same 403 as an ungranted one, whatever the body.
  expect((await print(`/api/v1/devices/${lan}/print`, granted, pdf(1))).status).toBe(403);
  expect((await print("/api/v1/devices/192.168.1.50/print", granted, pdf(1))).status).toBe(403);
  expect((await print("/api/v1/devices/999/print", granted, pdf(1))).status).toBe(403);
  expect(received.length).toBe(0);
  // A named address in the query is ignored: the job still goes only to the declared one.
  expect((await print(`/api/v1/devices/${deviceId}/print?url=${lan}`, granted, pdf(1))).status).toBe(200);
  expect(received.length).toBe(1);
});

test("an ungranted caller is refused before its body is read", async () => {
  const big = new Uint8Array(PDF_MAX_BYTES + 1);
  const res = await print(`/api/v1/devices/${deviceId}/print`, "not-a-token", big);
  expect(res.status).toBe(403); // not 422 too_large: the size was never looked at
});

test("an app is limited to a few prints a minute", async () => {
  const owner = getUserByName(app.db, "alice")!;
  addApp("a3", "chatty");
  grantDevice(app.db, deviceId, "chatty", owner.id);
  const t = mintAppToken(app.db, owner.id, "chatty", "production").token;
  const statuses: number[] = [];
  for (let i = 0; i < PRINTS_PER_MINUTE + 1; i++) statuses.push((await print(`/api/v1/devices/${deviceId}/print`, t, pdf(1))).status);
  expect(statuses.slice(0, PRINTS_PER_MINUTE).every((s) => s === 200)).toBe(true);
  expect(statuses[PRINTS_PER_MINUTE]).toBe(429);
  // Another app's budget is its own.
  expect((await print(`/api/v1/devices/${deviceId}/print`, granted, pdf(1))).status).toBe(200);
});

test("prints, grants and revokes append their events", () => {
  const kinds = app.db.query<{ kind: string; payload: string }, []>("SELECT kind, payload FROM event WHERE kind LIKE 'device.%'").all();
  const printed = kinds.find((k) => k.kind === "device.printed");
  expect(printed).toBeDefined();
  expect(JSON.parse(printed!.payload)).toMatchObject({ device: "Hall", app: "labels", pages: 2 });
});

test("the owner grants and revokes on the device page", async () => {
  const post = (path: string, body: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url, cookie },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  expect((await post("/settings/devices/grant", { id: String(deviceId), app: "other" })).status).toBe(303);
  expect((await print(`/api/v1/devices/${deviceId}/print`, ungranted, pdf(1))).status).toBe(200);
  const page = await (await fetch(`${servers.url}/settings/devices`, { headers: { cookie } })).text();
  expect(page).toContain("Allowed apps");
  const events = () => app.db.query<{ kind: string }, []>("SELECT kind FROM event").all().map((e) => e.kind);
  expect(events()).toContain("device.granted");
  expect((await post("/settings/devices/revoke", { id: String(deviceId), app: "other" })).status).toBe(303);
  expect(events()).toContain("device.revoked");
  expect((await print(`/api/v1/devices/${deviceId}/print`, ungranted, pdf(1))).status).toBe(403);
});

test("a non-admin is refused on grant and revoke, and changes nothing", async () => {
  const { createUser } = await import("../src/core/users.ts");
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  const { createSession } = await import("../src/core/sessions.ts");
  const bob = `forge_session=${createSession(app.db, made.value.id).token}`;
  const res = await fetch(`${servers.url}/settings/devices/grant`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url, cookie: bob },
    body: new URLSearchParams({ id: String(otherId), app: "other" }),
    redirect: "manual",
  });
  expect(res.status).not.toBe(303);
  expect(isGranted(app.db, otherId, "a2")).toBe(false);
});

test("an object stream cannot hide the page tree behind a plain decoy", () => {
  const decoy = "%PDF-1.5\n<< /Type /Pages /Count 1 >>\n5 0 obj\n<< /Type /ObjStm /N 1 >>\nstream\n\nendstream\n%%EOF\n";
  expect(checkPdf(enc.encode(decoy))).toEqual({ ok: false, error: "pages_unknown" });
  expect(checkPdf(enc.encode(decoy.replace("/ObjStm", "/Obj#53tm")))).toEqual({ ok: false, error: "pages_unknown" });
});

test("the page count is read from the plain page tree", () => {
  expect(pageCount(pdf(3))).toBe(3);
  expect(checkPdf(enc.encode("%PDF-1.5\n<< /Type /ObjStm >>\n%%EOF"))).toEqual({ ok: false, error: "pages_unknown" });
});
