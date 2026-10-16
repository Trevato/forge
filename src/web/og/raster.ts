/**
 * The one rasterizer: resvg compiled to WebAssembly, vendored under
 * `./vendor/` with the DejaVu fonts the card is drawn in (see the README's
 * dependency list). Nothing is loaded at import: the first PNG asks for it,
 * so a forge that cannot load it still boots and answers everything else.
 * A failed load is remembered for RETRY_MS and then tried again.
 */

import { join } from "node:path";

export type Rasterizer = (svg: string) => Uint8Array;

const RETRY_MS = 30_000;
const VENDOR = join(import.meta.dir, "vendor");
const FONTS = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf"];

/** The wasm can be initialised once per process; a retried load reuses it. */
let wasm: Promise<typeof import("./vendor/resvg.mjs")> | undefined;

function initOnce() {
  return (wasm ??= (async () => {
    const mod = await import("./vendor/resvg.mjs");
    await mod.initWasm(await Bun.file(join(VENDOR, "resvg.wasm")).arrayBuffer());
    return mod;
  })().catch((error) => {
    wasm = undefined;
    throw error;
  }));
}

async function load(): Promise<Rasterizer> {
  const { Resvg } = await initOnce();
  const fontBuffers = await Promise.all(
    FONTS.map(async (f) => new Uint8Array(await Bun.file(join(VENDOR, f)).arrayBuffer())),
  );
  const font = {
    fontBuffers,
    defaultFontFamily: "DejaVu Sans",
    sansSerifFamily: "DejaVu Sans",
    monospaceFamily: "DejaVu Sans Mono",
  };
  return (svg) => {
    const r = new Resvg(svg, { font, fitTo: { mode: "original" } });
    try {
      const img = r.render();
      try {
        return img.asPng();
      } finally {
        img.free();
      }
    } finally {
      r.free();
    }
  };
}

let loading: Promise<Rasterizer> | undefined;
let loader: () => Promise<Rasterizer> = load;

export function rasterizer(): Promise<Rasterizer> {
  if (!loading) {
    const mine = (loading = loader());
    mine.catch(() => setTimeout(() => loading === mine && (loading = undefined), RETRY_MS).unref());
  }
  return loading;
}

/** For tests: stand in for the loader (or restore it) and forget what was loaded. */
export function useLoader(next?: () => Promise<Rasterizer>): void {
  loader = next ?? load;
  loading = undefined;
}
