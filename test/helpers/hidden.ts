/** Whether the first `needle` in `html` sits inside a `<div … hidden>`. */
export function insideHiddenDiv(html: string, needle: string): boolean {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not in the page`);
  const open: boolean[] = [];
  for (const m of html.slice(0, at).matchAll(/<(\/?)div\b([^>]*)>/g)) {
    if (m[1]) open.pop();
    else open.push(/\shidden(\s|$|=)/.test(m[2] ?? ""));
  }
  return open.some(Boolean);
}
