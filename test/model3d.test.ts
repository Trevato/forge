/**
 * The 3D view (#7335): STL in both forms and OBJ parsed to the same cube,
 * the blob page's frame naming the viewer bundle and the media route, a
 * file too large to read still drawn because the browser fetches it, and
 * the server never parsing a model — a broken STL gets the same frame.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { bounds, isBinaryStl, MeshError, parseObj, parseStl, sizeText } from "../src/web/render/mesh.ts";
import { model3d, model3dAsset, model3dAssetPath } from "../src/web/render/model3d.ts";
import { RENDERERS, rendererFor } from "../src/web/render/renderers.ts";
import { REFUSED_URI, withinModelDir } from "../src/web/render/gltf-uri.ts";
import { modelFacts, type ModelFacts } from "../src/web/render/model-facts.ts";
import { moduleLoaderJs, shellJs } from "../src/web/client.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

const modelLine = (m: ModelFacts): string => `${m.title} · ${m.facts}`;

quietLogs();

const FIXTURES = join(import.meta.dir, "fixtures", "model3d");
const fixture = async (name: string): Promise<Uint8Array> => Bun.file(join(FIXTURES, name)).bytes();

describe("the mesh parsers", () => {
  test("an ASCII and a binary cube are 12 triangles in a 20 × 20 × 20 box", async () => {
    for (const name of ["cube-ascii.stl", "cube-binary.stl"]) {
      const mesh = parseStl(await fixture(name));
      expect([name, mesh.triangles]).toEqual([name, 12]);
      expect([name, bounds(mesh.positions).size]).toEqual([name, [20, 20, 20]]);
    }
  });

  test("a binary STL whose header opens with `solid` is still read as binary", async () => {
    const bytes = await fixture("cube-binary.stl");
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("solid");
    expect(isBinaryStl(bytes)).toBe(true);
    expect(isBinaryStl(await fixture("cube-ascii.stl"))).toBe(false);
  });

  test("an OBJ of six quads is the same cube, fanned into triangles", async () => {
    const mesh = parseObj(new TextDecoder().decode(await fixture("cube.obj")));
    expect(mesh.triangles).toBe(12);
    expect(bounds(mesh.positions)).toEqual({ min: [0, 0, 0], max: [20, 20, 20], size: [20, 20, 20] });
  });

  test("OBJ counts a negative index back from the last vertex", () => {
    const mesh = parseObj("v 0 0 0\nv 1 0 0\nv 0 2 0\nf -3 -2 -1\n");
    expect(mesh.triangles).toBe(1);
    expect(bounds(mesh.positions).size).toEqual([1, 2, 0]);
  });

  test("a file that is not the format says so instead of drawing nonsense", () => {
    expect(() => parseObj("v 0 0 0\nf 1 2 3\n")).toThrow(MeshError);
    expect(() => parseObj("v 0 zero 0\n")).toThrow(MeshError);
    expect(() => parseStl(new TextEncoder().encode("hello"))).toThrow(MeshError);
    expect(() =>
      parseStl(new TextEncoder().encode("solid x\nfacet\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\n")),
    ).toThrow(MeshError);
  });

  test("the header's box reads in millimetres", () => {
    expect(sizeText([20, 20.004, 3.5])).toBe("20 × 20 × 3.5 mm");
  });
});

describe("which files the 3D view draws", () => {
  const body = new Uint8Array([0x73, 0x6f, 0x6c, 0x69, 0x64]);
  const here = { media: true };
  test("STL, OBJ, GLB and glTF go to the 3D view", () => {
    for (const path of ["a.stl", "b/c.OBJ", "d.gltf"])
      expect([path, rendererFor(path, { kind: "text", body, size: 5 }, RENDERERS, here)?.render]).toEqual([path, model3d]);
    const glb = new TextEncoder().encode("glTF\x02\0\0\0");
    expect(rendererFor("e.glb", { kind: "binary", body: glb, size: 8 }, RENDERERS, here)?.render).toBe(model3d);
  });

  test("a part too large for the page to read is still drawn: the browser fetches it", () => {
    expect(rendererFor("tower.stl", { kind: "too_large", size: 30_000_000 }, RENDERERS, here)?.render).toBe(model3d);
    // A kind that reads its body is not handed one it does not have.
    expect(rendererFor("big.md", { kind: "too_large", size: 30_000_000 }, RENDERERS, here)?.render).toBeUndefined();
  });

  test("over the size cap there is no view, and the page offers Download", () => {
    expect(rendererFor("huge.stl", { kind: "too_large", size: 200_000_000 }, RENDERERS, here)?.render).toBeUndefined();
  });

  test("a page with no media route (a live browse of another forge) keeps a model's source view", () => {
    expect(rendererFor("a.stl", { kind: "text", body, size: 5 }, RENDERERS, { media: false })?.render).toBeUndefined();
    // Audio and video play from the media route too, so they keep theirs.
    expect(rendererFor("a.webm", { kind: "too_large", size: 9_000_000 }, RENDERERS, { media: false })).toBeUndefined();
    // Markdown reads its body, so it is drawn there as it always was.
    expect(rendererFor("a.md", { kind: "text", body, size: 5 }, RENDERERS, { media: false })?.render).toBeDefined();
  });

  test("the frame names the media route, the viewer bundle and a Download, and carries no script", () => {
    const media = "/alice/parts/media/main/tower/clip.stl";
    const download = `${media}?download=1`;
    const { content, lines } = model3d({ path: "tower/clip.stl", size: 684, body, media, download });
    expect(lines).toBe(0);
    expect(content.text).toContain(`data-src="${media}"`);
    expect(content.text).toContain('data-format="stl"');
    expect(content.text).toContain(`data-module="${model3dAssetPath()}"`);
    expect(content.text).toContain(`href="${download}"`);
    expect(content.text).not.toContain("<script");
    expect(model3dAssetPath()).toMatch(/^\/assets\/model3d-[0-9a-f]{16}\.js$/);
  });

  test("the toggles are script-only buttons that say whether they are held, and the note is the empty state", () => {
    const { content } = model3d({ path: "a.stl", size: 5, body, media: "/m", download: "/m?download=1" });
    const toggles = content.text.match(/<button[^>]*>/g) ?? [];
    expect(toggles).toHaveLength(2);
    for (const b of toggles) {
      expect(b).toContain('type="button"');
      expect(b).toMatch(/class="btn js-only"/);
      expect(b).toContain('aria-pressed="false"');
    }
    expect(content.text).toContain('value="wireframe"');
    expect(content.text).toContain('value="axes"');
    expect(content.text).toContain('class="empty"');
    expect(content.text).toContain("#i-file");
  });
});

describe("what a glTF may make the browser fetch", () => {
  const page = "https://forge.test/alice/parts/blob/main/tower/arm.gltf";
  const dir = "/alice/parts/media/main/tower/";
  test("a file beside the model, or below it, is fetched", () => {
    expect(withinModelDir("/alice/parts/media/main/tower/arm.bin", dir, page)).toBe(true);
    expect(withinModelDir("/alice/parts/media/main/tower/tex/skin.png", dir, page)).toBe(true);
    expect(withinModelDir("https://forge.test/alice/parts/media/main/tower/arm.bin", dir, page)).toBe(true);
  });

  test("anything that walks out, or leaves the origin, is refused", () => {
    for (const uri of [
      "/alice/parts/media/main/tower/../../../../../settings/tokens",
      "/alice/parts/media/main/tower/%2e%2e/%2e%2e/secret",
      "/alice/parts/media/main/tower/..%2f..%2fsecret",
      "/alice/parts/media/main/tower/..%5csecret",
      "/api/v1/user",
      "/alice/parts/media/main/towerish/x.bin",
      "//evil.test/x.bin",
      "https://evil.test/alice/parts/media/main/tower/x.bin",
      "https://user:pw@forge.test/alice/parts/media/main/tower/x.bin",
      "data:application/octet-stream;base64,AAAA",
      "blob:https://forge.test/1234",
      "javascript:alert(1)",
      dir,
    ])
      expect([uri, withinModelDir(uri, dir, page)]).toEqual([uri, false]);
    expect(REFUSED_URI.startsWith("about:")).toBe(true);
  });
});

describe("a model in words, for the terminal", () => {
  test("STL in either form and OBJ: the format, the triangles and the box in mm", async () => {
    for (const name of ["cube-ascii.stl", "cube-binary.stl"]) {
      const bytes = await fixture(name);
      expect(modelLine(modelFacts(name, bytes, bytes.length))).toBe("3D model · STL · 12 triangles · 20 × 20 × 20 mm");
    }
    const obj = await fixture("cube.obj");
    expect(modelLine(modelFacts("cube.obj", obj, obj.length))).toBe("3D model · OBJ · 12 triangles · 20 × 20 × 20 mm");
  });

  test("a GLB is read from its JSON: vertex counts, and position bounds in metres", () => {
    const text = JSON.stringify({
      asset: { version: "2.0" },
      accessors: [
        { count: 8, min: [0, 0, 0], max: [0.02, 0.02, 0.02] },
        { count: 36 },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    });
    // A GLB chunk is padded with spaces to four bytes.
    const chunk = new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
    const glb = new Uint8Array(20 + chunk.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, chunk.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(chunk, 20);
    expect(modelLine(modelFacts("cube.glb", glb, glb.length))).toBe("3D model · GLB · 12 triangles · 20 × 20 × 20 mm");
  });

  test("over the cap a model is named and sized, not read; a broken one says so", () => {
    expect(modelLine(modelFacts("big.stl", null, 30_000_000))).toBe("3D model · STL · 30.0 MB");
    expect(modelLine(modelFacts("bad.stl", new TextEncoder().encode("nope"), 4))).toBe(
      "3D model · STL · not a readable STL file",
    );
  });
});

describe("the shell's module loader", () => {
  /** The loader against a stand-in document, as the shell runs it. */
  function loader(modules: string[]) {
    const added: { type: string; src: string; nonce: string }[] = [];
    const doc = {
      currentScript: { nonce: "n0nce" },
      head: { appendChild: (s: { type: string; src: string; nonce: string }) => added.push({ ...s }) },
      createElement: () => ({ type: "", src: "", nonce: "" }),
      querySelectorAll: () => modules.map((m) => ({ getAttribute: () => m })),
    };
    const load = new Function("doc", `${moduleLoaderJs}; return loadModules;`)(doc) as () => void;
    return { load, added, modules };
  }

  test("a figure's first-party module is loaded once, with the shell's nonce, even across swaps", () => {
    const l = loader([model3dAssetPath()]);
    l.load();
    l.load(); // the code browser swapped the same kind of file in again
    expect(l.added).toEqual([{ type: "module", src: model3dAssetPath(), nonce: "n0nce" }]);
  });

  test("anything but an asset's exact shape is refused", () => {
    const l = loader([
      "/assets/../alice/x/raw/main/evil.js",
      "/assets/model3d-abc.js?x=1",
      "//evil.test/assets/a.js",
      "https://evil.test/assets/a.js",
      "/assets/A.js",
      "/alice/x/media/main/a.js",
    ]);
    l.load();
    expect(l.added).toEqual([]);
  });

  test("the shell carries the loader and runs it on a swap", () => {
    expect(shellJs).toContain(moduleLoaderJs);
    expect(shellJs).toContain("doc.addEventListener('code:swap', loadModules)");
  });
});

describe("the 3D view on the forge", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-model3d-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-model3d-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const repo = await createRepo(app, a.value, { name: "tower", visibility: "public" });
    if (!repo.ok) throw new Error("repo failed");
    const made = await commitToBranch(app, a.value, repo.value, {
      message: "parts",
      files: [
        { path: "parts/cube.stl", content: await fixture("cube-binary.stl") },
        { path: "parts/broken.stl", content: "this is not a model\n" },
      ],
    });
    if (!made.ok) throw new Error("commit failed");
  });

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the blob page carries the viewer's module and the media URL, and Source and Download stay", async () => {
    const res = await fetch(`${base}/alice/tower/blob/main/parts/cube.stl`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(`data-module="${model3dAssetPath()}"`);
    expect(page).toContain('data-src="/alice/tower/media/main/parts/cube.stl"');
    expect(page).toContain('href="/alice/tower/blob/main/parts/cube.stl?view=source"');
    expect(page).toContain('href="/alice/tower/media/main/parts/cube.stl?download=1"');
    // The module is a first-party script, so the page's own-origin script policy admits it.
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");

    const bytes = await fetch(`${base}/alice/tower/media/main/parts/cube.stl`);
    expect(bytes.headers.get("content-type")).toBe("model/stl");
    expect(Buffer.from(await bytes.arrayBuffer()).equals(Buffer.from(await fixture("cube-binary.stl")))).toBe(true);
  });

  test("the code browser's swapped-in fragment carries the module the shell loads", async () => {
    const res = await fetch(`${base}/alice/tower/blob/main/parts/cube.stl?fragment=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`data-module="${model3dAssetPath()}"`);
  });

  test("the server never parses the model: a broken STL gets the same frame", async () => {
    const page = await (await fetch(`${base}/alice/tower/blob/main/parts/broken.stl`)).text();
    expect(page).toContain('data-src="/alice/tower/media/main/parts/broken.stl"');
  });

  test("the viewer bundle is served immutable, with three.js and the parsers inside", async () => {
    const res = await fetch(`${base}${model3dAssetPath()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const code = await res.text();
    expect(code).toBe((await model3dAsset())!.code);
    expect(code).toContain("a facet without three vertices");
    expect(code).toContain("WebGLRenderer");
    expect((await fetch(`${base}/assets/model3d-0000000000000000.js`)).status).toBe(404);
  });
});
