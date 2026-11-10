/**
 * Cross-Origin-Resource-Policy (#10965): a page, an API answer and a 404 are
 * `same-origin`, so another site cannot load them as a no-cors subresource;
 * the public set — assets, icons, feeds, the crawler and agent files, the
 * manifest, `/.well-known/*` and the share cards link previews draw — says
 * `cross-origin` on purpose. A feed or share card asked for with a session
 * stays `same-origin`: it may hold what only that person can see.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { crossOriginAllowed } from "../src/http/corp.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { spriteAsset, stylesheetAsset } from "../src/web/asset.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-corp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "ada", email: "ada@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app.db, app.reposRoot, { ownerId: admin.value.id, name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const seed = await commitToBranch(app, admin.value, made.value, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
  if (!seed.ok) throw new Error(String(seed.error));
  cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function corp(path: string, signedIn = false): Promise<[number, string | null]> {
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  if (signedIn) headers.cookie = cookie;
  const res = await fetch(`${servers.url}${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel();
  return [res.status, res.headers.get("cross-origin-resource-policy")];
}

const SAME_ORIGIN: [string, string | (() => string), boolean?][] = [
  ["page", "/"],
  ["page, signed in", "/", true],
  ["repository page", "/ada/notes"],
  ["API answer", "/api/v1/repos/ada/notes"],
  ["API answer, signed in", "/api/v1/user", true],
  ["404 page", "/no/such/path/at/all"],
  ["404 JSON", "/api/v1/no-such-route"],
  ["404 of an asset", "/assets/not-a-real-hash.css"],
  ["feed, signed in", "/ada/notes/activity.atom", true],
  ["share card, signed in", "/og/site.svg", true],
];

const CROSS_ORIGIN: [string, string | (() => string)][] = [
  ["stylesheet asset", () => `/assets/${stylesheetAsset().name}.css`],
  ["sprite asset", () => `/assets/${spriteAsset().name}.svg`],
  ["changelog feed", "/changelog.atom"],
  ["repository feed", "/ada/notes/activity.atom"],
  ["robots.txt", "/robots.txt"],
  ["llms.txt", "/llms.txt"],
  ["sitemap", "/sitemap.xml"],
  ["manifest", "/manifest.webmanifest"],
  ["well-known", "/.well-known/security.txt"],
  ["favicon", "/favicon.ico"],
  ["site share card (svg)", "/og/site.svg"],
  ["site share card (png)", "/og/site.png"],
  ["repository share card", "/og/repo/ada~notes.svg"],
];

test("private answers, API answers and errors are same-origin", async () => {
  const wrong: string[] = [];
  for (const [kind, path, signedIn] of SAME_ORIGIN) {
    const [status, value] = await corp(typeof path === "function" ? path() : path, signedIn === true);
    if (value !== "same-origin") wrong.push(`${kind} (${status}): ${value}`);
  }
  expect(wrong).toEqual([]);
}, 60_000);

test("the public set says cross-origin on purpose", async () => {
  const wrong: string[] = [];
  for (const [kind, path] of CROSS_ORIGIN) {
    const [status, value] = await corp(typeof path === "function" ? path() : path);
    if (status >= 400) wrong.push(`${kind}: answered ${status}`);
    else if (value !== "cross-origin") wrong.push(`${kind} (${status}): ${value}`);
  }
  expect(wrong).toEqual([]);
}, 60_000);

test("only the public set is exempt", () => {
  const anonymous = new Request("http://forge.local/");
  const signed = new Request("http://forge.local/", { headers: { authorization: "Bearer x" } });
  expect(crossOriginAllowed(anonymous, "/assets/app.css")).toBe(true);
  expect(crossOriginAllowed(signed, "/assets/app.css")).toBe(true);
  expect(crossOriginAllowed(anonymous, "/ada/notes/activity.atom")).toBe(true);
  expect(crossOriginAllowed(signed, "/ada/notes/activity.atom")).toBe(false);
  expect(crossOriginAllowed(anonymous, "/api/v1/user")).toBe(false);
  expect(crossOriginAllowed(anonymous, "/ada/notes/raw/main/a.txt")).toBe(false);
  expect(crossOriginAllowed(anonymous, "/x/assets/a.css")).toBe(false);
});
