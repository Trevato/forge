/**
 * The machine shell page's two files, content-addressed and immutable like the
 * highlighter (`web/asset.ts`):
 *
 * - `/assets/machine-term-<hash>.js` — `web/machine-term-client.ts` bundled
 *   with the vendored ghostty-web (`src/web/vendor/ghostty-web`, MIT, 0.4.0) by
 *   `Bun.build` at first use. The vendored module also carries its
 *   WebAssembly as a base64 `data:` URL; the bundle drops that copy (the page
 *   fetches the file below instead), so the script is about 75 KB rather than 680
 *   and the page's CSP needs no `data:` in `connect-src`.
 * - `/assets/ghostty-vt-<hash>.wasm` — the emulator's WebAssembly, read once.
 *
 * A failed build is not fatal: the page says the terminal could not load.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../kernel/hash.ts";
import { createLog } from "../kernel/log.ts";
import { staticResponse, type BuiltAsset } from "./asset.ts";

const log = createLog("web");

export const VENDOR_DIR = join(import.meta.dir, "vendor", "ghostty-web");

/** The vendored module's inlined WebAssembly: a string literal, base64. */
const INLINE_WASM = /(["'`])data:application\/wasm;base64,[A-Za-z0-9+/=]+\1/g;

/** The vendored source with its inlined WebAssembly replaced by an empty `data:` URL. */
export function withoutInlineWasm(source: string): string {
  return source.replace(INLINE_WASM, '"data:,"');
}

let pending: Promise<BuiltAsset | null> | null = null;

/** The shell page's script, built once per process. */
export function machineTermAsset(): Promise<BuiltAsset | null> {
  pending ??= build();
  return pending;
}

async function build(): Promise<BuiltAsset | null> {
  try {
    const built = await Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL("./machine-term-client.ts", import.meta.url))],
      target: "browser",
      format: "esm",
      minify: true,
      plugins: [
        {
          name: "ghostty-web-without-inline-wasm",
          setup(builder) {
            builder.onLoad({ filter: /vendor[\\/]ghostty-web[\\/]ghostty-web\.js$/ }, async (args) => ({
              contents: withoutInlineWasm(await Bun.file(args.path).text()),
              loader: "js",
            }));
          },
        },
      ],
    });
    const first = built.outputs[0];
    if (!built.success || first === undefined || built.outputs.length !== 1) {
      log.warn("web.machine_term_asset_failed", { logs: built.logs.length, outputs: built.outputs.length });
      return null;
    }
    const code = await first.text();
    const hash = sha256(code);
    const name = `machine-term-${hash.slice(0, 16)}`;
    return { path: `/assets/${name}.js`, name, code, etag: `"${hash}"` };
  } catch (error) {
    log.warn("web.machine_term_asset_failed", { error: String(error) });
    return null;
  }
}

export interface WasmAsset {
  readonly path: string;
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly etag: string;
}

let wasm: WasmAsset | null = null;

/** The emulator's WebAssembly, read and hashed once per process. */
export function ghosttyWasmAsset(): WasmAsset {
  if (wasm === null) {
    const bytes = new Uint8Array(readFileSync(join(VENDOR_DIR, "ghostty-vt.wasm")));
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const name = `ghostty-vt-${hash.slice(0, 16)}`;
    wasm = { path: `/assets/${name}.wasm`, name, bytes, etag: `"${hash}"` };
  }
  return wasm;
}

/** The response for a hit on the WebAssembly: immutable, because it is. */
export function wasmResponse(request: Request): Response {
  const asset = ghosttyWasmAsset();
  return staticResponse(request, asset.bytes, "application/wasm", asset.etag);
}
