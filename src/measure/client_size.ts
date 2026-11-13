/**
 * The client bytes of one page (#12018): the JavaScript and CSS a browser
 * must fetch or parse to draw it, as gzip bytes. Counted from the page's own
 * HTML: each `<script src>` and `<link rel=stylesheet>` it names (the bodies
 * served at those URLs, compressed with gzip level default) plus every
 * inline `<script>` and `<style>` body. Data blocks (`type=application/json`,
 * speculation rules) are not code and are left out.
 * The ceilings live in docs/design/size-budget.json, written by
 * `FORGE_SIZE_WRITE=1 bun test test/client-size.test.ts` as the measured
 * bytes plus headroom (#12040, `ceilingFor`), so one landed byte does not red
 * main; a pull that grows a page past its ceiling raises it in the same push
 * and says why.
 */

export interface ClientSize {
  readonly js: number;
  readonly css: number;
}

export type Ceilings = Record<string, ClientSize>;

const gz = (text: string): number => Bun.gzipSync(new TextEncoder().encode(text)).length;

/** Each `src` of a script and `href` of a stylesheet, same-origin paths only, in page order. */
function linkedAssets(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = /\ssrc="([^"]+)"/i.exec(m[1]!)?.[1];
    if (src !== undefined && src.startsWith("/")) scripts.push(src);
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (!/\srel="?stylesheet/i.test(m[1]!)) continue;
    const href = /\shref="([^"]+)"/i.exec(m[1]!)?.[1];
    if (href !== undefined && href.startsWith("/")) styles.push(href);
  }
  return { scripts, styles };
}

/** The command that rewrites the ceilings from today's measure. */
export const SIZE_WRITE_COMMAND = "FORGE_SIZE_WRITE=1 bun test test/client-size.test.ts";

/** Headroom over the measured bytes a written ceiling keeps: 2 %, then up to a whole block. */
const HEADROOM_FRACTION = 0.02;
const HEADROOM_BLOCK = 256;

/**
 * The ceiling written for `bytes` measured (#12040): bytes × 1.02, rounded up to
 * the next multiple of 256 B. Integer arithmetic (bytes·102/100, ceiling) so no
 * float rounding moves a boundary: 1000 → 1020 → 1024; 1004 → 1024.08 → 1280.
 */
export function ceilingFor(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`bytes must be a non-negative integer, got ${bytes}`);
  const grown = Math.ceil((bytes * (100 + HEADROOM_FRACTION * 100)) / 100);
  return Math.ceil(grown / HEADROOM_BLOCK) * HEADROOM_BLOCK;
}

/** Every page's ceilings with headroom over its measured size. */
export function ceilingsFor(sizes: Ceilings): Ceilings {
  const out: Ceilings = {};
  for (const [page, s] of Object.entries(sizes)) out[page] = { js: ceilingFor(s.js), css: ceilingFor(s.css) };
  return out;
}

/** The bodies of inline scripts (code only) and styles. */
function inlineCode(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1]!;
    if (/\ssrc=/i.test(attrs)) continue;
    const type = /\stype="([^"]*)"/i.exec(attrs)?.[1]?.toLowerCase();
    if (type !== undefined && type !== "module" && type !== "text/javascript") continue;
    if (m[2]!.trim() !== "") scripts.push(m[2]!);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) if (m[1]!.trim() !== "") styles.push(m[1]!);
  return { scripts, styles };
}

/** Each counted inline block, labelled by kind and order (`script #2`), to compare renders. */
function inlineBlocks(html: string): { label: string; body: string }[] {
  const inline = inlineCode(html);
  return [
    ...inline.scripts.map((body, i) => ({ label: `script #${i + 1}`, body })),
    ...inline.styles.map((body, i) => ({ label: `style #${i + 1}`, body })),
  ];
}

/**
 * What differs in counted code between two renders of one page; empty when the
 * same. A per-request value (a nonce, a time, an id) inside an inline block makes
 * the count vary run to run; it belongs in a data block or an attribute.
 */
export function inlineDrift(page: string, first: string, second: string): string[] {
  const a = inlineBlocks(first);
  const b = inlineBlocks(second);
  if (a.length !== b.length) return [`${page}: ${a.length} counted inline blocks on one render, ${b.length} on the next`];
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.body === b[i]!.body) continue;
    let at = 0;
    while (a[i]!.body[at] === b[i]!.body[at]) at++;
    const near = (s: string): string => JSON.stringify(s.slice(Math.max(0, at - 40), at + 40));
    out.push(`${page}: inline ${a[i]!.label} differs between two renders at char ${at}: ${near(a[i]!.body)} vs ${near(b[i]!.body)}`);
  }
  return out;
}

/** The page's client bytes; `fetchText` answers an asset path with its plain body. */
export async function clientSize(html: string, fetchText: (path: string) => Promise<string>): Promise<ClientSize> {
  const linked = linkedAssets(html);
  const inline = inlineCode(html);
  const sum = async (paths: string[], bodies: string[]): Promise<number> => {
    let n = 0;
    for (const p of [...new Set(paths)]) n += gz(await fetchText(p));
    for (const b of bodies) n += gz(b);
    return n;
  };
  return { js: await sum(linked.scripts, inline.scripts), css: await sum(linked.styles, inline.styles) };
}

/**
 * The finding for one page over its ceiling, naming the page, the bytes over and the
 * command that raises it; none within.
 */
export function sizeFindings(page: string, size: ClientSize, ceiling: ClientSize | undefined): string[] {
  if (ceiling === undefined)
    return [`${page}: no ceiling in docs/design/size-budget.json (js ${size.js} B, css ${size.css} B gzip); write one with \`${SIZE_WRITE_COMMAND}\``];
  const out: string[] = [];
  for (const kind of ["js", "css"] as const)
    if (size[kind] > ceiling[kind])
      out.push(`${page}: ${kind} ${size[kind]} B gzip, ${size[kind] - ceiling[kind]} B over its ceiling of ${ceiling[kind]} B; raise it in this pull with \`${SIZE_WRITE_COMMAND}\` and say why`);
  return out;
}
