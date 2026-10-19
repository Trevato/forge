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
 */

import { smoke } from "../src/release/smoke.ts";
export * from "../src/release/smoke.ts";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    return args.splice(i, 2)[1];
  };
  const version = flag("--version");
  const wait = flag("--wait");
  const base = args[0];
  const seconds = wait === undefined ? 120 : Number(wait);
  if (!base || !Number.isFinite(seconds) || seconds < 0 || args.length > 1) {
    console.error("usage: bun scripts/smoke.ts <url> [--version <v>] [--wait <seconds>]");
    process.exit(2);
  }
  const failures = await smoke(base, process.env["FORGE_TOKEN"] ?? "", { version, waitMs: seconds * 1000 });
  for (const f of failures)
    console.error(`FAIL ${f.url} agent=${f.agent} status=${f.status} content-type=${f.contentType || "-"} (${f.why})`);
  if (failures.length) process.exit(1);
  console.log(`smoke ok: ${base}`);
}
