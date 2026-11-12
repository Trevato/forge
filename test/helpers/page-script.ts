/**
 * A page's own script is a hashed file (`web/asset.ts`), not inline text.
 * A test that asserts what the page's script does reads the file the page names.
 */
export async function pageScriptOf(base: string, html: string): Promise<string> {
  const src = /<script src="(\/assets\/page-[0-9a-f]+\.js)" defer><\/script>/.exec(html)?.[1];
  if (src === undefined) return "";
  return await (await fetch(base + src)).text();
}

/** The page's markup followed by every script file it names: what the browser would run. */
export async function withScripts(base: string, html: string): Promise<string> {
  const srcs = [...html.matchAll(/<script src="(\/assets\/[\w.-]+\.js)"/g)].map((m) => m[1]!);
  const code = await Promise.all(srcs.map(async (s) => (await fetch(base + s)).text()));
  return html + "\n" + code.join("\n");
}
