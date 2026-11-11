/**
 * An STL, OBJ or glTF file as a part you can turn: a server-rendered frame,
 * and the viewer (`model3d-client.ts`, with the vendored three.js) loaded
 * only by the pages that carry one.
 *
 * The server never reads a model's bytes to draw it. The figure names the
 * media route (`input.media`), and the viewer fetches and parses there, in
 * the browser; so a 100 MB part costs the blob page nothing but its frame,
 * and a file too big to read whole is drawn all the same. With no
 * JavaScript, or no WebGL, the frame's note and Download button are what
 * stays.
 *
 * The bundle is named by a hash of its sources, not of its output, so the
 * page knows the address without waiting for a build; the first request for
 * it builds once per process, as the highlighter's does (`web/asset.ts`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../kernel/hash.ts";
import { createLog } from "../../kernel/log.ts";
import type { BuiltAsset } from "../asset.ts";
import { html, type Html } from "../html.ts";
import { btn, empty, fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

const log = createLog("web");

const ENTRY = Bun.fileURLToPath(new URL("./model3d-client.ts", import.meta.url));
const VENDOR = join(import.meta.dir, "vendor", "three");

/** What the viewer reads each extension as. */
const FORMATS: Readonly<Record<string, string>> = { stl: "stl", obj: "obj", glb: "glb", gltf: "gltf", "3mf": "3mf" };

const formatOf = (path: string): string =>
  FORMATS[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "stl";

export function model3d(input: RenderInput): Rendered {
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const toggle = (label: string, value: string): Html =>
    btn(label, { type: "button", size: "sm", variant: "outline", extra: "js-only", pressed: false, value });
  return {
    lines: 0,
    content: html`<figure
      class="model3d"
      data-src="${input.media}"
      data-format="${formatOf(input.path)}"
      data-label="3D view of ${name}"
      data-module="${model3dAssetPath()}"
    >
      <figcaption class="model3d-head">
        <dl class="row-facts">
          <div><dt>Format</dt><dd>${formatOf(input.path).toUpperCase()}</dd></div>
          <div><dt>File</dt><dd>${fileSize(input.size)}</dd></div>
          <div data-triangles hidden><dt>Triangles</dt><dd></dd></div>
          <div data-box hidden><dt>Box</dt><dd></dd></div>
        </dl>
        <span class="muted" data-stats aria-live="polite"></span>
        <span class="spacer"></span>
        <span class="model3d-tools" data-tools hidden>
          ${toggle("Wireframe", "wireframe")} ${toggle("Axes", "axes")}
        </span>
      </figcaption>
      <div class="model3d-stage" data-stage>
        ${empty({
          icon: "file",
          title: "A 3D model",
          note: "Turning it needs JavaScript and WebGL; Download opens it elsewhere.",
          action: btn("Download", { href: input.download, variant: "primary", icon: "download" }),
        })}
      </div>
    </figure>`,
  };
}

/** Every source the bundle is built from, in a stable order. */
function sources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
      .sort();
  return [ENTRY, join(import.meta.dir, "mesh.ts"), ...walk(VENDOR)];
}

let path: string | null = null;

/** `/assets/model3d-<hash>.js`, from the sources alone: no build is waited on. */
export function model3dAssetPath(): string {
  if (path === null) {
    const hash = sha256(sources().map((file) => sha256(readFileSync(file))).join("\n"));
    path = `/assets/model3d-${hash.slice(0, 16)}.js`;
  }
  return path;
}

let pending: Promise<BuiltAsset | null> | null = null;

/** The viewer bundle, built once per process; null when the build fails. */
export function model3dAsset(): Promise<BuiltAsset | null> {
  pending ??= build();
  return pending;
}

async function build(): Promise<BuiltAsset | null> {
  const name = model3dAssetPath().slice("/assets/".length, -".js".length);
  try {
    const built = await Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL("./model3d-client.ts", import.meta.url))],
      target: "browser",
      format: "esm",
      minify: true,
      plugins: [
        {
          name: "vendored-three",
          setup(b) {
            // The vendored files are three's own, unedited: they import
            // `three`, which is the vendored build.
            b.onResolve({ filter: /^three$/ }, () => ({ path: join(VENDOR, "build", "three.module.js") }));
            b.onResolve({ filter: /^three\/addons\// }, (args) => ({
              path: join(VENDOR, "examples", "jsm", args.path.slice("three/addons/".length)),
            }));
          },
        },
      ],
    });
    const first = built.outputs[0];
    if (!built.success || first === undefined) {
      log.warn("web.model3d_asset_failed", { logs: built.logs.length });
      return null;
    }
    const code = await first.text();
    return { path: `/assets/${name}.js`, name, code, etag: `"${sha256(code)}"` };
  } catch (error) {
    log.warn("web.model3d_asset_failed", { error: String(error) });
    return null;
  }
}
