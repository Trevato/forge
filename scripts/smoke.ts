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
 * `--standards` runs the website-specification report (`release/webspec.ts`)
 * over forge.json's `app.looks` paths (head, headers, well-known files, error pages,
 * a no-JavaScript render and axe-core in light and dark, `release/axe.ts`), prints one
 * line per finding with its section (`--error-path` names a path that must answer
 * 500), and exits 0: it reports, it does not gate.
 *
 * `--version` also loads `/boards`, `/`, `/explore`, `/search?q=a` and a repository home (`--repo`, default
 * /trevato/forge, skipped on 404) and watches `/healthz` for `--watch` seconds (default 60); see `release/smoke.ts`.
 *
 * `--app-host <url>` also fetches `/` there and fails if it is the forge's page (`<title>forge</title>`).
 *
 * `--outsider` also signs up a fresh account and proves each thing a
 * stranger must not do is refused over HTTP and MCP (`release/outsider.ts`,
 * #663); the terminal door is proven by the gate. It makes one real account, so run it against a forge whose signup is open to it, with
 * `FORGE_TOKEN` naming the private repositories to reach for.
 */

import { smoke } from "../src/release/smoke.ts";
import { axe, noScript } from "../src/release/axe.ts";
import { findChromium } from "../src/looks/capture.ts";
import { webspec } from "../src/release/webspec.ts";
import { outsider } from "../src/release/outsider.ts";
import { PROBE_HEADER } from "../src/kernel/probe.ts";
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
  const standards = args.includes("--standards");
  if (standards) args.splice(args.indexOf("--standards"), 1);
  const errorPath = flag("--error-path");
  const appHost = flag("--app-host");
  const version = flag("--version");
  const wait = flag("--wait");
  const watchFor = flag("--watch");
  const repo = flag("--repo");
  const base = args[0];
  const seconds = wait === undefined ? 120 : Number(wait);
  const watchSeconds = watchFor === undefined ? undefined : Number(watchFor);
  if (!base || (watchSeconds !== undefined && !(watchSeconds >= 0)) || !Number.isFinite(seconds) || seconds < 0 || args.length > 1) {
    console.error("usage: bun scripts/smoke.ts <url> [--version <v>] [--wait <seconds>] [--watch <seconds of /healthz watching, default 60>] [--repo </owner/name>] [--outsider] [--app-host <url of an app>] [--standards [--error-path <path that answers 500>]]  (--version needs FORGE_PROBE, the forge's probe)");
    process.exit(2);
  }
  if (withOutsider && !process.env["FORGE_TOKEN"]) {
    console.error("--outsider needs FORGE_TOKEN naming the owner's repos: private reads, steering, the form door and MCP tells cannot be tried without it");
    process.exit(2);
  }
  if (standards) {
    const looks = (await Bun.file(new URL("../forge.json", import.meta.url)).json())?.app?.looks;
    const paths: string[] = Array.isArray(looks) ? looks.filter((p): p is string => typeof p === "string") : ["/"];
    const findings = [
      ...(await webspec(base, paths, fetch, { site: true, ...(errorPath ? { errorPath } : {}) })),
      ...(await axe(base, paths)),
      ...(findChromium() === undefined ? await noScript(base, paths) : []),
    ];
    for (const f of findings) console.log(`${f.path} ${f.check}${f.edge ? " (edge)" : ""}: ${f.message} <${f.section}>`);
    console.log(`standards: ${findings.length} finding(s) over ${paths.length} path(s); report only`);
    process.exit(0);
  }
  const failures = await smoke(base, process.env["FORGE_TOKEN"] ?? "", {
    version,
    // A release (`--version`) loads the heavy pages and watches /healthz after go-live (#6898).
    ...(version ? { heavy: { ...(watchSeconds === undefined ? {} : { watchMs: watchSeconds * 1000 }), ...(repo ? { repo } : {}) } } : {}),
    waitMs: seconds * 1000,
    ...(appHost ? { appHost } : {}),
    // The forge tells only its probe its version (`src/kernel/probe.ts`).
    ...(process.env["FORGE_PROBE"] ? { probe: { [PROBE_HEADER]: process.env["FORGE_PROBE"] } } : {}),
  });
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
