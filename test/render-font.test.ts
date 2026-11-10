/** A font file on the blob page: kind, family name, specimen, and a CSP that only it relaxes. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { fontFamily } from "../src/web/render/font.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** A minimal sfnt: one `name` table holding a Windows (UTF-16BE) family name. */
function sfnt(magic: number[], family: string): Uint8Array {
  const text = new Uint8Array(family.length * 2);
  for (let i = 0; i < family.length; i++) text[i * 2 + 1] = family.charCodeAt(i);
  const table = new Uint8Array(6 + 12 + text.length);
  const t = new DataView(table.buffer);
  t.setUint16(2, 1); // one record
  t.setUint16(4, 18); // string storage offset
  t.setUint16(6, 3); // platform: Windows
  t.setUint16(8, 1);
  t.setUint16(10, 0x409);
  t.setUint16(12, 1); // nameID 1: family
  t.setUint16(14, text.length);
  t.setUint16(16, 0);
  table.set(text, 18);
  const out = new Uint8Array(12 + 16 + table.length);
  out.set(magic, 0);
  const v = new DataView(out.buffer);
  v.setUint16(4, 1);
  out.set(new TextEncoder().encode("name"), 12);
  v.setUint32(20, 28);
  v.setUint32(24, table.length);
  out.set(table, 28);
  return out;
}

const TTF = sfnt([0, 1, 0, 0], "Forge <Sans>");
const OTF = sfnt([0x4f, 0x54, 0x54, 0x4f], "Forge Serif");
const WOFF = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
const FAKE = new TextEncoder().encode("this is plainly not a font\n");

describe("font kind and family", () => {
  test("detected by magic bytes, and a renamed non-font is not a font", () => {
    expect(fileKind("a.ttf", TTF)).toBe("font");
    expect(fileKind("a.otf", OTF)).toBe("font");
    expect(fileKind("a.woff", WOFF)).toBe("font");
    expect(fileKind("a.woff2", new TextEncoder().encode("wOF2\0\0"))).toBe("font");
    expect(fileKind("fake.ttf", FAKE)).toBe("text");
    expect(fileKind("fake.ttf", new Uint8Array([1, 2, 0, 3]))).toBe("binary");
    expect(fileKind("a.otf", TTF)).not.toBe("font");
  });

  test("the family is read from the name table", () => {
    expect(fontFamily(TTF)).toBe("Forge <Sans>");
    expect(fontFamily(OTF)).toBe("Forge Serif");
  });

  test("a truncated or hostile table is no family, not a crash", () => {
    expect(fontFamily(TTF.subarray(0, 30))).toBeUndefined();
    const bad = TTF.slice();
    new DataView(bad.buffer).setUint32(20, 0xfffffff0);
    expect(fontFamily(bad)).toBeUndefined();
    expect(fontFamily(new Uint8Array(3))).toBeUndefined();
  });
});

let dataDir = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-font-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-font-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  const repo = await createRepo(app, a.value, { name: "type", visibility: "public" });
  if (!repo.ok) throw new Error("repo failed");
  const made = await commitToBranch(app, a.value, repo.value, {
    message: "fonts",
    files: [
      { path: "a.ttf", content: TTF },
      { path: "b.woff", content: WOFF },
      { path: "fake.ttf", content: FAKE },
      { path: "n.txt", content: new TextEncoder().encode("hi\n") },
    ],
  });
  if (!made.ok) throw new Error("commit failed");
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${servers.url}/alice/type/${path}`);

describe("font blob pages", () => {
  test("a ttf is a specimen named by its family, escaped, with script and font-src", async () => {
    const res = await get("blob/main/a.ttf");
    const html = (await res.text()).replace(/\s+/g, " ");
    expect(html).toContain('<h2 class="font-name">Forge &lt;Sans&gt;</h2>');
    expect(html).toContain('data-font="/alice/type/media/main/a.ttf"');
    expect(html).toContain("Sphinx of black quartz");
    for (const size of ["font-s", "font-m", "font-l"]) expect(html).toContain(size);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("font-src 'self';");
    expect(csp).not.toMatch(/font-src[^;]*data:/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the kept page, served again, still has font-src and the script", async () => {
    const first = await get("blob/main/a.ttf");
    await first.text();
    const res = await get("blob/main/a.ttf");
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self';");
    expect(html).toContain('data-font="/alice/type/media/main/a.ttf"');
    // The script is a hashed asset; the kept page must name the one that draws the specimen.
    const src = /<script src="(\/assets\/page-[^"]+\.js)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    expect(await (await fetch(`${servers.url}${src}`)).text()).toContain("FontFace");
  });

  test("a woff is named by its file name", async () => {
    const html = await (await get("blob/main/b.woff")).text();
    expect(html).toContain('<h2 class="font-name">b</h2>');
  });

  test("the bytes are served as a font type", async () => {
    const res = await get("media/main/a.ttf");
    expect(res.headers.get("content-type")).toBe("font/ttf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a renamed non-font is plain source and its media is octet-stream", async () => {
    const res = await get("blob/main/fake.ttf");
    const html = await res.text();
    expect(html).not.toContain("font-view");
    expect(res.headers.get("content-security-policy")).not.toContain("font-src");
    expect((await get("media/main/fake.ttf")).headers.get("content-type")).toBe("application/octet-stream");
  });

  test("no other page gains font-src, the source view included", async () => {
    for (const path of ["blob/main/n.txt", "blob/main/a.ttf?view=source", ""]) {
      const csp = (await get(path)).headers.get("content-security-policy")!;
      expect(csp, path).not.toContain("font-src");
    }
  });
});
