/**
 * The client bytes of one page (#12018): the JavaScript and CSS a browser
 * must fetch or parse to draw it, as gzip bytes. Counted from the page's own
 * HTML: each `<script src>` and `<link rel=stylesheet>` it names (the bodies
 * served at those URLs, compressed with gzip level default) plus every
 * inline `<script>` and `<style>` body. Data blocks (`type=application/json`,
 * speculation rules) are not code and are left out.
 * The ceilings live in docs/design/size-budget.json; a pass may lower one
 * (FORGE_SIZE_WRITE=1 rewrites the file), nothing may raise one without a
 * note in the pull.
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

/** The finding for one page over its ceiling, naming the page and the bytes over; none within. */
export function sizeFindings(page: string, size: ClientSize, ceiling: ClientSize | undefined): string[] {
  if (ceiling === undefined) return [`${page}: no ceiling in docs/design/size-budget.json (js ${size.js} B, css ${size.css} B gzip)`];
  const out: string[] = [];
  for (const kind of ["js", "css"] as const)
    if (size[kind] > ceiling[kind])
      out.push(`${page}: ${kind} ${size[kind]} B gzip, ${size[kind] - ceiling[kind]} B over its ceiling of ${ceiling[kind]} B`);
  return out;
}
