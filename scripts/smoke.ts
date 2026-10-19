/**
 * `bun scripts/smoke.ts <url>` — is the forge answering, as a phone and as a
 * desktop? Each of `/`, `/board` (signed in with `FORGE_TOKEN`) and
 * `/healthz` is fetched once per user agent and must answer 200; the
 * stylesheet linked from `/` must be a non-empty `text/css` 200. Exit 1 and
 * one line per failure (url, user agent, status, content type) otherwise.
 *
 * `--version <v>` first polls `/healthz` until `X-Forge-Version` is `<v>`, for
 * at most `--wait <seconds>` (default 120), and fails naming the last version
 * seen. `/sw.js` must be a 200 JavaScript response whose navigation branch
 * never answers with `Response.error()`.
 *
 * `--outsider` also signs up a fresh account and proves each thing a
 * stranger must not do is refused over HTTP and MCP (`release/outsider.ts`,
 * #663); the terminal door is proven by the gate. It makes one real account, so run it against a forge whose signup is open to it, with
 * `FORGE_TOKEN` naming the private repositories to reach for.
 */

import { smoke } from "../src/release/smoke.ts";
import { outsider } from "../src/release/outsider.ts";
export * from "../src/release/smoke.ts";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    return args.splice(i, 2)[1];
  };
  const withOutsider = args.includes("--outsider");
  if (withOutsider) args.splice(args.indexOf("--outsider"), 1);
  const version = flag("--version");
  const wait = flag("--wait");
  const base = args[0];
  const seconds = wait === undefined ? 120 : Number(wait);
  if (!base || !Number.isFinite(seconds) || seconds < 0 || args.length > 1) {
    console.error("usage: bun scripts/smoke.ts <url> [--version <v>] [--wait <seconds>] [--outsider]");
    process.exit(2);
  }
  if (withOutsider && !process.env["FORGE_TOKEN"]) {
    console.error("--outsider needs FORGE_TOKEN naming the owner's repos: private reads, steering, the form door and MCP tells cannot be tried without it");
    process.exit(2);
  }
  const failures = await smoke(base, process.env["FORGE_TOKEN"] ?? "", { version, waitMs: seconds * 1000 });
  for (const f of failures)
    console.error(`FAIL ${f.url} agent=${f.agent} status=${f.status} content-type=${f.contentType || "-"} (${f.why})`);
  const unrefused = withOutsider
    ? await outsider(base, { ...(process.env["FORGE_TOKEN"] ? { ownerToken: process.env["FORGE_TOKEN"] } : {}) })
    : [];
  for (const r of unrefused) console.error(`FAIL outsider: ${r.check} (${r.why})`);
  if (failures.length || unrefused.length) process.exit(1);
  if (withOutsider) console.log("outsider suite ok for HTTP and MCP; the terminal door is proven by the gate (test/outsider-tty.test.ts)");
  console.log(`smoke ok: ${base}`);
}
