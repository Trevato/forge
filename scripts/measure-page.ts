/**
 * Measure admin pages: the rendered height (`document.documentElement.
 * scrollHeight`, or an element's box for `path#id`) in headless Chromium, and
 * the word count (`src/measure/words.ts`, the one method both modes use).
 * Usage and the table it prints: docs/features/measure-page.md.
 *
 *   bun scripts/measure-page.ts [--root DIR] [--width 1440] [--shots DIR] [--words-only] /path[#id] …
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childEnv } from "../src/apps/process.ts";
import { findChromium } from "../src/looks/capture.ts";
import { wordsOf } from "../src/measure/words.ts";

const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const wordsOnly = args.includes("--words-only");
const root = resolve(take("--root") ?? ".");
const width = Number(take("--width") ?? 1440);
const shots = take("--shots");
const paths = args.filter((a) => a.startsWith("/"));
if (!Number.isInteger(width) || width < 200 || width > 4000 || paths.length === 0) {
  console.error("usage: bun scripts/measure-page.ts [--root DIR] [--width N] [--shots DIR] [--words-only] /path[#id] …");
  process.exit(2);
}
const binary = findChromium();
if (binary === undefined && !wordsOnly) {
  console.error("no Chromium on this machine (--words-only needs none)");
  process.exit(3);
}
const split = (p: string): [string, string] => [p.split("#")[0]!, p.split("#")[1] ?? ""];

type Send = (method: string, params?: object) => Promise<any>;

/** One Chromium and its one page, driven over the devtools socket; killed when `run` ends. */
async function withPage<T>(run: (send: Send, loaded: () => Promise<void>) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), "forge-measure-"));
  const proc = Bun.spawn(
    [binary!, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0"],
    { env: childEnv({}), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  let ws: WebSocket | undefined;
  try {
    const reader = proc.stderr.getReader();
    let buf = "";
    let browser = "";
    while (browser === "") {
      const { done, value } = await reader.read();
      if (done) throw new Error("chromium exited before printing its devtools address");
      buf += new TextDecoder().decode(value);
      browser = buf.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? "";
    }
    reader.cancel().catch(() => {});
    const base = browser.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
    const list = (await (await fetch(`${base}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    ws = new WebSocket(list.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await new Promise<void>((ok, bad) => {
      ws!.addEventListener("open", () => ok());
      ws!.addEventListener("error", () => bad(new Error("devtools refused the connection")));
    });
    let id = 0;
    const pending = new Map<number, (m: any) => void>();
    let onLoad: () => void = () => {};
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.id !== undefined) pending.get(m.id)?.(m);
      else if (m.method === "Page.loadEventFired") onLoad();
    });
    const send: Send = (method, params = {}) =>
      new Promise((ok, bad) => {
        const n = ++id;
        const t = setTimeout(() => bad(new Error(`${method} timed out`)), 15_000);
        pending.set(n, (m) => {
          clearTimeout(t);
          if (m.error) bad(new Error(m.error.message));
          else ok(m.result);
        });
        ws!.send(JSON.stringify({ id: n, method, params }));
      });
    const loaded = () => new Promise<void>((ok) => (onLoad = ok));
    return await run(send, loaded);
  } finally {
    ws?.close();
    proc.kill("SIGKILL");
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

const dir = mkdtempSync(join(tmpdir(), "forge-measure-data-"));
const imp = (file: string) => import(join(root, file));
const { createApp } = await imp("src/app.ts");
const { createUser } = await imp("src/core/users.ts");
const { createSession } = await imp("src/core/sessions.ts");
const { createRepo } = await imp("src/core/repos.ts");
const { mintProposalToken } = await imp("src/core/proposal_token.ts");
const { addSubscription } = await imp("src/core/subscriptions.ts");
const { createAgent, addToCrew } = await imp("src/actions/crew.ts");
const { serve } = await imp("src/http/server.ts");
const app = createApp({ dataDir: dir, port: 0 });
const servers = await serve(app);
const must = (r: { ok: boolean; error?: unknown; value?: any }, what: string) => {
  if (!r.ok) throw new Error(`seeding ${what}: ${JSON.stringify(r.error)}`);
  return r.value;
};
try {
  const alice = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true }), "alice");
  const actor = { ...alice, isAdmin: true };
  const repo = must(await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "demo" }), "repo");
  // Rows, so a page's growth per row shows: five tokens, three crew, three subscriptions.
  for (let n = 1; n <= 5; n++)
    must(mintProposalToken(app.db, alice.id, repo.id, { child: `child-${n}`, origin: `https://child-${n}.example.com/` }), "token");
  for (const [n, role] of ["planner", "builder", "reviewer"].entries()) {
    must(await createAgent(app, actor, { username: `bot-${n}`, roles: [role] }), "agent");
    must(addToCrew(app, actor, repo, `bot-${n}`, role), "crew");
  }
  for (let n = 1; n <= 3; n++)
    must(addSubscription(app.db, dir, { name: `plan-${n}`, token: `sk-ant-oat01-${"x".repeat(20)}${n}` }), "subscription");
  const token = createSession(app.db, alice.id).token;

  /** One page at one size and theme: its height and words; with `out`, a picture. */
  const look = (target: string, w: number, dark: boolean, out?: string) =>
    withPage(async (send, loaded) => {
      const [path, id] = split(target);
      await send("Page.enable");
      await send("Network.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: w === 1440 ? 900 : 844, deviceScaleFactor: 1, mobile: w < 700 });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await send("Network.setCookie", { name: "forge_session", value: token, url: servers.url });
      const done = loaded();
      await send("Page.navigate", { url: `${servers.url}${path}` });
      await done;
      await Bun.sleep(400);
      const r = await send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => { const id = ${JSON.stringify(id)};
          const el = id ? (document.getElementById(id) || [...document.querySelectorAll("h2")].find((h) => h.textContent.trim().toLowerCase() === id.replace(/-/g, " "))?.closest(".card, section")) : null;
          return JSON.stringify({ height: el ? Math.round(el.getBoundingClientRect().height) : document.documentElement.scrollHeight, html: document.documentElement.outerHTML }); })()`,
      });
      const got = JSON.parse(r.result.value) as { height: number; html: string };
      if (out !== undefined) {
        const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        writeFileSync(out, Buffer.from(s.data, "base64"));
      }
      return { height: got.height, words: wordsOf(got.html, id) };
    });

  if (shots !== undefined) mkdirSync(shots, { recursive: true });
  for (const target of paths) {
    if (wordsOnly) {
      const [path, id] = split(target);
      const res = await fetch(`${servers.url}${path}`, { headers: { cookie: `forge_session=${token}` } });
      console.log(JSON.stringify({ path: target, status: res.status, words: wordsOf(await res.text(), id) }));
      continue;
    }
    console.log(JSON.stringify({ path: target, width, ...(await look(target, width, false)) }));
    if (shots !== undefined)
      for (const w of [1440, 390])
        for (const dark of [false, true])
          await look(target, w, dark, join(shots, `${target.replace(/^\//, "").replace(/\W+/g, "-")}-${w}-${dark ? "dark" : "light"}.png`));
  }
} finally {
  servers.stop();
  app.close();
  rmSync(dir, { recursive: true, force: true });
}
