/**
 * `bun scripts/home-read.ts <url>` prints a page as the eye reads it, then
 * `chars N · words N · fetched in N ms` (#5765): step 1 of the home cold read
 * (#5735), so every read starts from the same text. `FORGE_COOKIE`, when set,
 * is sent as the cookie and never printed. Exits 1 on a non-200 status.
 */
import { pageText } from "../src/web/page_text.ts";

const url = process.argv[2];
if (!url || !/^https?:\/\//i.test(url)) {
  console.error("usage: bun scripts/home-read.ts <http(s)://url>");
  process.exit(2);
}
const cookie = process.env.FORGE_COOKIE;
const started = performance.now();
const res = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(15_000) });
const html = await res.text();
const ms = Math.round(performance.now() - started);
if (res.status !== 200) {
  console.error(`${url} answered ${res.status}`);
  process.exit(1);
}
const text = pageText(html);
const words = text.split(/\s+/).filter(Boolean).length;
console.log(text);
console.log(`chars ${text.length} · words ${words} · fetched in ${ms} ms`);
