/** `?` lists the keys on /flow and /system, from the shared shell, not a copy (#10747). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

const get = async (path: string) => (await fetch(`${f.base}${path}`, { headers: { cookie: f.ownerCookie } })).text();
const shellSrc = (html: string) => /<script src="(\/assets\/shell-[^"]+\.js)" defer>/.exec(html)?.[1];

for (const path of ["/flow", "/system"]) {
  test(`${path}: the key list is in the markup and the keys script is the shared shell`, async () => {
    const html = await get(path);
    // The same dialog and words as every other page: a closed <dialog>, so opening it moves nothing.
    expect(html).toContain('<dialog class="dialog" id="help-dialog"');
    expect(html).toContain("Keyboard shortcuts");
    expect(html).toContain("data-help-body");
    // The very same shell asset as another page that has the list, and no copy inline.
    const src = shellSrc(html);
    expect(src).toBeDefined();
    expect(shellSrc(await get("/boards"))).toBe(src);
    expect(html).not.toContain("openHelp");
    const js = await (await fetch(`${f.base}${src}`)).text();
    expect(js).toContain("['?'], function (e)");
    expect(js).toContain("help-dialog");
  });
}
