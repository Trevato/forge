/**
 * Home as a browser leaves it (#7660): the page, with each region it served
 * from memory and marked `data-refresh` replaced by that region drawn fresh
 * from its own fragment. A test that wrote something and then reads home
 * means this one.
 */
export async function freshHome(base: string, cookie?: string, path = "/"): Promise<string> {
  const headers = cookie ? { cookie } : {};
  let text = await (await fetch(`${base}${path}`, { headers })).text();
  for (;;) {
    const open = /<div id="home-\w+" data-region data-refresh="([^"]+)">/.exec(text);
    if (open === null) return text;
    const src = open[1]!.replace(/&amp;/g, "&");
    const fresh = await (await fetch(`${base}${src}`, { headers })).text();
    const inner = fresh.replace(/^\s*<div[^>]*>/, "").replace(/<\/div>\s*$/, "");
    const from = open.index + open[0].length;
    let depth = 1;
    let end = from;
    for (const m of text.slice(from).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        end = from + m.index;
        break;
      }
    }
    text = `${text.slice(0, open.index)}<div data-fresh>${inner}${text.slice(end)}`;
  }
}
