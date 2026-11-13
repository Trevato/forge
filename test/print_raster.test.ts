/**
 * An app prints PWG raster through the print route: checked before the LAN,
 * then sent as image/pwg-raster.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mintAppToken } from "../src/apps/token.ts";
import { grantDevice } from "../src/core/device_grants.ts";
import { declareDevice } from "../src/core/devices.ts";
import { getUserByName } from "../src/core/users.ts";
import { readPwg } from "../src/devices/pwg.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

const enc = new TextEncoder();
const attr = (tag: number, name: string, value: string | number | number[]) => {
  const n = enc.encode(name);
  const v = typeof value === "number" ? [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255] : typeof value === "string" ? [...enc.encode(value)] : value;
  return [tag, n.length >> 8, n.length & 255, ...n, v.length >> 8, v.length & 255, ...v];
};
const be = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/**
 * A PWG page: 1796-byte header, then `height` identical white lines as one
 * repeated PackBits line.
 */
function page(width = 64, height = 32, dpi = 600, space = 18, bits = 8): Uint8Array {
  const h = new Uint8Array(1796);
  const v = new DataView(h.buffer);
  v.setUint32(276, dpi); v.setUint32(280, dpi);
  v.setUint32(372, width); v.setUint32(376, height);
  v.setUint32(384, bits);
  const channels = space === 18 ? 1 : 3;
  v.setUint32(388, bits * channels);
  const line = Math.ceil((width * bits * channels) / 8);
  v.setUint32(392, line);
  v.setUint32(400, space);
  const pixel = (bits * channels) / 8;
  const data: number[] = [height - 1];
  let left = width;
  while (left > 0) {
    const run = Math.min(left, 128);
    data.push(run - 1, ...new Array(pixel).fill(0xff));
    left -= run;
  }
  return Uint8Array.from([...h, ...data]);
}
const pwg = (...pages: Uint8Array[]) => Uint8Array.from([...enc.encode("RaS2"), ...pages.flatMap((p) => [...p])]);

let received: Uint8Array[] = [];
let capabilities: number[] = [];
const printer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = new Uint8Array(await req.arrayBuffer());
    received.push(body);
    const getAttributes = body[3] === 0x0b;
    return new Response(
      Uint8Array.from([
        1, 1, 0, 0, 0, 0, 0, 1,
        0x01, ...attr(0x47, "attributes-charset", "utf-8"),
        0x02, ...(getAttributes ? capabilities : [...attr(0x21, "job-id", 7), ...attr(0x23, "job-state", 9)]),
        0x03,
      ]),
      { headers: { "content-type": "application/ipp" } },
    );
  },
});

let dataDir = "", granted = "", deviceId = 0;
let app: App, servers: Servers;
const prior = process.env.FORGE_DEVICES_ALLOW_LOOPBACK;

beforeAll(async () => {
  process.env.FORGE_DEVICES_ALLOW_LOOPBACK = "1";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pwg-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const owner = getUserByName(app.db, "alice")!;
  app.db.run("PRAGMA foreign_keys = OFF");
  app.db.run("INSERT INTO app (id, repo_id, slug, access) VALUES ('a1', 'repo-a1', 'paper', 'private')");
  app.db.run("PRAGMA foreign_keys = ON");
  const d = declareDevice(app.db, { name: "Brother", kind: "printer", url: `ipp://127.0.0.1:${printer.port}/ipp/print` });
  if (!d.ok) throw new Error("declare");
  deviceId = d.value.id;
  expect(grantDevice(app.db, deviceId, "paper", owner.id).ok).toBe(true);
  granted = mintAppToken(app.db, owner.id, "paper", "production").token;
});
afterAll(async () => {
  if (prior === undefined) delete process.env.FORGE_DEVICES_ALLOW_LOOPBACK;
  else process.env.FORGE_DEVICES_ALLOW_LOOPBACK = prior;
  printer.stop(true);
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const print = (body: Uint8Array) =>
  fetch(`${servers.url}/api/v1/devices/${deviceId}/print`, {
    method: "POST",
    headers: { connection: "close", "content-type": "image/pwg-raster", authorization: `Bearer ${granted}` },
    body,
  });

const includes = (hay: Uint8Array, needle: Uint8Array): boolean => Buffer.from(hay).includes(Buffer.from(needle));

test("a two-page 600 dpi sgray_8 file reaches the printer as image/pwg-raster, byte for byte", async () => {
  capabilities = [];
  received = [];
  const doc = pwg(page(), page());
  const parsed = readPwg(doc);
  expect(parsed.ok && parsed.value.map((p) => [p.dpi[0], p.type])).toEqual([[600, "sgray_8"], [600, "sgray_8"]]);
  const res = await print(doc);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ job: { id: 7, state: "completed", reasons: [] } });
  const job = received.find((r) => r[3] === 0x02)!;
  expect(Buffer.from(job).toString("latin1")).toContain("image/pwg-raster");
  expect(Buffer.from(job).toString("latin1")).not.toContain("application/pdf");
  expect(job.length).toBeGreaterThan(doc.length);
  expect(includes(job, doc)).toBe(true);
  const row = app.db.query("SELECT pages, outcome FROM print_job ORDER BY rowid DESC LIMIT 1").get();
  expect(row).toEqual({ pages: 2, outcome: "printed" });
});

test("a truncated header, a wrong sync word and 21 pages are 422 and nothing reaches the device", async () => {
  received = [];
  const good = pwg(page());
  expect((await print(good.subarray(0, 500))).status).toBe(422);
  expect((await print(good.subarray(0, good.length - 3))).status).toBe(422);
  const wrong = good.slice();
  wrong.set(enc.encode("RaS3"));
  const r = await print(wrong);
  expect(r.status).toBe(422);
  expect(((await r.json()) as { error: string }).error).toBe("not_raster");
  const many = await print(pwg(...Array.from({ length: 21 }, () => page(8, 2))));
  expect(many.status).toBe(422);
  expect(((await many.json()) as { error: string }).error).toBe("too_many_pages");
  expect(received.length).toBe(0);
  expect((await print(pwg(...Array.from({ length: 20 }, () => page(8, 2))))).status).toBe(200);
});

test("a page the printer says it cannot take is refused with a sentence, before the job is sent", async () => {
  capabilities = [
    ...attr(0x32, "pwg-raster-document-resolution-supported", [...be(300), ...be(300), 3]),
    ...attr(0x44, "pwg-raster-document-type-supported", "srgb_8"),
  ];
  received = [];
  const r = await print(pwg(page()));
  expect(r.status).toBe(422);
  expect(((await r.json()) as { error: string }).error).toBe("raster_resolution_refused");
  capabilities = [
    ...attr(0x32, "pwg-raster-document-resolution-supported", [...be(600), ...be(600), 3]),
    ...attr(0x44, "pwg-raster-document-type-supported", "srgb_8"),
  ];
  const t = await print(pwg(page()));
  expect(t.status).toBe(422);
  expect(((await t.json()) as { error: string }).error).toBe("raster_type_refused");
  expect(received.every((x) => x[3] === 0x0b)).toBe(true);
  capabilities = [
    ...attr(0x32, "pwg-raster-document-resolution-supported", [...be(600), ...be(600), 3]),
    ...attr(0x44, "pwg-raster-document-type-supported", "sgray_8"),
  ];
  expect((await print(pwg(page()))).status).toBe(200);
});

test("PackBits runs that overrun a line or the page are refused", () => {
  const p = page(64, 32);
  const bad = p.slice();
  bad[1796] = 40; // line repeat past the page height
  expect(readPwg(pwg(bad)).ok).toBe(false);
  expect(readPwg(pwg(page(64, 32, 600, 19, 8))).ok).toBe(true); // srgb_8
});
