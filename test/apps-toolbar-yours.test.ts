/** The pill's "Make it yours": a public app's stranger gets the fork page; the owner and a private app get nothing. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { yoursLink } from "../src/apps/crew.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { setSealed } from "../src/core/sealed.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
let dataDir = "";
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let alice = "";
let bob = "";
let pub: AppRecord;
let priv: AppRecord;
let orgApp: AppRecord;
let reader = "";
let gone = "";
let openPull = 0;
let sealedPullNo = 0;
let backend: ReturnType<typeof Bun.serve>;
let status: ReturnType<typeof spyOn>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-yours-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
  await runtime.start();
  const person = async (username: string, adminIfFirst?: boolean) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}) });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const a = await person("alice", true);
  alice = a.id;
  bob = (await person("bob")).id;
  const make = async (name: string, visibility: "public" | "private") => {
    const made = await newApp(app, a, { name, description: "x", visibility });
    if (!made.ok) throw new Error(String(made.error));
    return getAppByRepo(app.db, made.value.repo.id)!;
  };
  backend = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/data") return Response.json({ ok: 1 });
      if (path === "/asset.js") return new Response("console.log(1)", { headers: { "content-type": "application/javascript" } });
      return new Response("<html><body>hi</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    (_r: AppRecord, env: string) => ({ env, state: "running", port: backend.port, commitOid: "a".repeat(40) }) as EnvStatus,
  );
  reader = (await person("reader")).id;
  gone = (await person("gone")).id;
  app.db.query("UPDATE user SET suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").run(gone);
  const org = createOrg(app.db, "acme", alice);
  if (!org.ok) throw new Error(org.error);
  const team = createTeam(app.db, org.value.id, "Readers", "read");
  if (!team.ok) throw new Error(team.error);
  addTeamMember(app.db, team.value, reader);
  const madeOrg = await newApp(app, a, { name: "orgapp", owner: "acme", description: "x", visibility: "public" });
  if (!madeOrg.ok) throw new Error(String(madeOrg.error));
  orgApp = getAppByRepo(app.db, madeOrg.value.repo.id)!;
  pub = await make("pubapp", "public");
  for (const sealed of [false, true]) {
    const pull = createIssue(app.db, { repoId: pub.repoId, authorId: a.id, title: "p", kind: "pull" });
    if (!pull.ok) throw new Error(pull.error);
    if (sealed) {
      setSealed(app.db, pull.value.id, true);
      sealedPullNo = pull.value.number;
    } else openPull = pull.value.number;
  }
  priv = await make("privapp", "private");
});
afterAll(async () => {
  status.mockRestore();
  backend.stop(true);
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const link = (a: AppRecord, who?: string) => yoursLink(app.db, servers.url, a, who);

test("a signed-out reader and a signed-in stranger of a public app are offered the fork page", () => {
  const want = `${servers.url}/alice/pubapp/make-it-yours`;
  expect(link(pub)).toBe(want);
  expect(link(pub, bob)).toBe(want);
});

test("the owner is offered nothing", () => {
  expect(link(pub, alice)).toBeUndefined();
});

test("a private app is offered nothing", () => {
  expect(priv.access).toBe("private");
  expect(link(priv)).toBeUndefined();
  expect(link(priv, bob)).toBeUndefined();
});

test("the endpoint takes who the reader is from the grant, never the client", async () => {
  const target = { app: pub, env: "production" } as AppTarget;
  const cookie = `forge_grant_${pub.id.slice(-8)}`;
  const ask = async (who: { id: string; name: string; role: string }) =>
    (await fetch(`${servers.url}/__forge/crew`, {
      headers: { host: `pubapp.${DOMAIN}`, cookie: `${cookie}=${signGrant(dataDir, target, 60_000, Date.now(), who as never)}` },
    })).json() as Promise<{ yours?: string }>;
  expect((await ask({ id: bob, name: "bob", role: "user" })).yours).toBe(`${servers.url}/alice/pubapp/make-it-yours`);
  expect((await ask({ id: alice, name: "alice", role: "admin" })).yours).toBeUndefined();
});

test("a read-only member of a public repository is offered the link; a suspended or unknown viewer is not", () => {
  const want = `${servers.url}/acme/orgapp/make-it-yours`;
  expect(link(orgApp, reader)).toBe(want);
  expect(link(orgApp, alice)).toBeUndefined();
  expect(link(pub, gone)).toBeUndefined();
  expect(link(pub, "no-such-user")).toBeUndefined();
  // A signed-out reader is the one who is offered it with no account at all.
  expect(link(pub)).toBeDefined();
});

const crewAt = async (host: string, who?: string, env = "production") => {
  const target = { app: pub, env } as AppTarget;
  const cookie = who === undefined ? {} : { cookie: `forge_grant_${pub.id.slice(-8)}=${signGrant(dataDir, target, 60_000, Date.now(), { id: who, name: "x", role: "user" } as never)}` };
  return (await fetch(`${servers.url}/__forge/crew`, { headers: { host, ...cookie } })).json() as Promise<{ yours?: string }>;
};

test("through the proxy, a preview of a sealed pull offers no link; an open pull's does", async () => {
  expect((await crewAt(`pubapp--${openPull}.${DOMAIN}`, bob, `pull-${openPull}`)).yours).toBe(`${servers.url}/alice/pubapp/make-it-yours`);
  expect((await crewAt(`pubapp--${sealedPullNo}.${DOMAIN}`, bob, `pull-${sealedPullNo}`)).yours).toBeUndefined();
  expect((await crewAt(`pubapp--${sealedPullNo}.${DOMAIN}`)).yours).toBeUndefined();
  expect((await crewAt(`pubapp.${DOMAIN}`, gone)).yours).toBeUndefined();
});

test("through the proxy, the link is in no JSON or asset answer; a page carries only the pill's tag", async () => {
  const get = (path: string) => fetch(`${servers.url}${path}`, { headers: { host: `pubapp.${DOMAIN}` } });
  const json = await get("/data");
  expect(await json.text()).toBe('{"ok":1}');
  const asset = await get("/asset.js");
  expect(await asset.text()).toBe("console.log(1)");
  for (const res of [json, asset]) expect(res.headers.get("link") ?? "").not.toContain("make-it-yours");
  const page = await (await get("/")).text();
  expect(page).toContain("/__forge/toolbar-");
  expect(page).not.toContain("make-it-yours");
});

/** Run the pill against a stub DOM and a crew answer; return the anchors and what sits under the shadow root. */
async function runPill(crew: unknown) {
  const forge = "http://forge.test";
  const anchors: Record<string, any>[] = [];
  const el = (): Record<string, any> => ({
    style: {}, dataset: {}, children: [] as any[],
    appendChild(c: any) { this.children.push(c); return c; },
    setAttribute() {}, addEventListener() {}, focus() {},
    attachShadow() { shadow = el(); return shadow; },
  });
  let shadow: Record<string, any> | undefined;
  const make = (tag: string) => { const e = el(); e.tag = tag; if (tag === "a") anchors.push(e); return e; };
  const inShadow = (node: any, hit: any): boolean => node === hit || (node.children ?? []).some((c: any) => inShadow(c, hit));
  const doc = { currentScript: { src: "/__forge/toolbar-x.js", dataset: { forge, app: "pubapp", env: "production" } }, createElement: make, addEventListener() {}, body: el() };
  const fn = new Function("window", "document", "fetch", "location", "URL", toolbarJs);
  await new Promise<void>((done) => {
    fn({}, doc, () => ({
      then: (f: (r: unknown) => unknown) => {
        f({ ok: true, json: () => crew });
        return { then: (g: (c: unknown) => void) => { g(crew); setTimeout(done, 0); return { catch() {} }; } };
      },
    }), { href: "https://pubapp.apps.test/" }, URL);
  });
  const yours = anchors.find((a) => a.textContent === "Make it yours");
  return { yours, inShadow: yours !== undefined && shadow !== undefined && inShadow(shadow, yours) };
}

test("the pill makes the anchor in its shadow root, same tab, with the forge's href; a foreign origin makes none", async () => {
  const good = await runPill({ yours: "http://forge.test/alice/pubapp/make-it-yours" });
  expect(good.yours?.href).toBe("http://forge.test/alice/pubapp/make-it-yours");
  expect(good.inShadow).toBe(true);
  expect(good.yours?.target).toBeUndefined();
  expect((await runPill({ yours: "https://evil.test/alice/pubapp/make-it-yours" })).yours).toBeUndefined();
  expect((await runPill({})).yours).toBeUndefined();
});
