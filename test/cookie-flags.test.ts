/**
 * Every cookie the forge sets (#5898): sign in by each door and read every
 * Set-Cookie. HttpOnly and SameSite=Lax|Strict on each, and Secure whenever
 * the public origin is https. Run for a forge on http and one declared https.
 * The walk at the end checks every cookie spelled in src/, reached or not (#10968).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { signGrant } from "../src/apps/proxy.ts";
import { newApp } from "../src/actions/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { issueRecovery, markVerified } from "../src/core/verify.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { device } from "./helpers/passkey.ts";

quietLogs();
setDefaultTimeout(60_000);

/**
 * Cookie-setting sites, counted per file (imports included) as `set-cookie` headers and
 * sessionCookie() calls. WALKED files have every site exercised above (by the
 * door named); UNREACHED ones are named with why. The scan below compares
 * these counts to the source exactly, so a new site in a listed file fails
 * until it is walked here or named.
 */
const WALKED: Record<string, number> = {
  "src/http/api/tokens.ts": 4, // password sign-in, sign-out: a set-cookie header and a sessionCookie() call each
  "src/http/server.ts": 1, // the mode switch
  "src/http/rp.ts": 6, // parent sign-in and link: state cookie set and cleared
  "src/apps/proxy.ts": 2, // app grant, app sign-out
  "src/web/pages/passkeys.ts": 5, // import, passkey sign-in, passkey add/recovery-link sign-in, access-link sign-in (+1 mention)
  "src/web/pages/site.ts": 4, // sessionCookie() itself and its uses: password sign-in/sign-up, logout; the theme cookie
  "src/web/layout.ts": 4, // the flash set on, and cleared from, a redirect
  "src/web/flash.ts": 2, // forge_flash
};
const UNREACHED: Record<string, { sites: number; why: string }> = {
  "src/http/addressed.ts": { sites: 1, why: "only asks whether a response sets a cookie, so it isn't shared; it sets none" },
  "src/apps/feedback.ts": { sites: 2, why: "the visitor cookie is set on a deployed app's own host from its feedback widget; covered by the feedback tests" },
  "src/web/pages/claim.ts": { sites: 1, why: "claiming the first admin seat needs a fresh forge with a claim link; same sessionCookie() as the walked doors" },
  "src/web/pages/first-admin.ts": { sites: 1, why: "first-admin recovery needs a forge with no admin; same sessionCookie() as the walked doors" },
  "src/web/pages/start_claim.ts": { sites: 1, why: "the claim of an agent's start needs a one-time token; same sessionCookie() as the walked doors; covered by test/start.test.ts" },
  "src/web/pages/signup-passkey.ts": { sites: 2, why: "sign-up by passkey needs an invite; same sessionCookie() as the walked doors" },
  "src/web/pages/map.ts": { sites: 1, why: "the map's last-looked cookie holds two timestamps, HttpOnly and Lax, and grants nothing; covered by test/roadmap.test.ts (name, HttpOnly, SameSite, no Secure over http)" },
  "src/http/measure.ts": { sites: 1, why: "the page-view beacon answers with the visitor cookie line from src/http/visitor.ts; HttpOnly, Lax, Secure over https from cookieLine; covered by test/visitors.test.ts" },
  "src/http/visitor.ts": { sites: 1, why: "the doc comment's mention of the Set-Cookie line it returns; covered by test/visitors.test.ts" },
  "src/perf/visitor_id.ts": { sites: 1, why: "cookieLine itself, the Set-Cookie line for forge_visitor: HttpOnly, SameSite=Lax, Secure over https; covered by test/visitors.test.ts" },
  "src/web/gift_cookie.ts": { sites: 1, why: "the gift code rides an HttpOnly, Lax cookie (Secure over https) and grants nothing by itself; covered by the gift code tests" },
  "src/web/pages/new-forge.ts": { sites: 1, why: "appends dropGift(), the gift cookie's clearing line from src/web/gift_cookie.ts" },
  "src/web/pages/everyday.ts": { sites: 2, why: "the admin/everyday switch needs a paired account; same sessionCookie() as the walked doors" },
};

const dirs: string[] = [];
const stops: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cookies-"));
  dirs.push(dir);
  return dir;
};

function check(label: string, cookies: string[], https: boolean) {
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    const flags = cookie.split(";").slice(1).map((f) => f.trim().toLowerCase());
    const where = `${label}: ${cookie.split("=")[0]}`;
    expect([where, flags.includes("httponly")]).toEqual([where, true]);
    expect([where, flags.includes("samesite=lax") || flags.includes("samesite=strict")]).toEqual([where, true]);
    expect([where, flags.includes("secure")]).toEqual([where, https]);
  }
}

for (const https of [false, true]) {
  describe(`cookie flags, forge on ${https ? "https" : "http"}`, () => {
    test("every door sets only HttpOnly, SameSite cookies" + (https ? ", all Secure" : ""), async () => {
      const seen: string[] = [];
      const take = (label: string, res: Response, ...want: string[]) => {
        const set = res.headers.getSetCookie();
        for (const name of want) expect([label, set.some((c) => c.startsWith(`${name}=`))]).toEqual([label, true]);
        check(label, set, https);
        seen.push(...set);
        return set;
      };
      const cookieOf = (set: string[], name: string) => set.map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`))!;

      const public_ = https ? "https://forge.cookies.test" : undefined;
      const parent = createApp({ dataDir: await tmp(), port: 0 });
      const ps: Servers = await serve(parent);
      const child: App = createApp({ dataDir: await tmp(), port: 0, parentUrl: ps.url, parentLoopback: true, ...(public_ ? { url: public_ } : {}) });
      const cs: Servers = await serve(child);
      stops.push(() => { ps.stop(); cs.stop(); });
      const origin = public_ ?? cs.url;

      const mk = async (app: App, username: string, adminIfFirst = false) => {
        const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.local`, password: "a-long-family-passphrase", adminIfFirst });
        if (!made.ok) throw new Error(made.error);
        return { id: made.value.id, user: made.value, cookie: `forge_session=${createSession(app.db, made.value.id).token}` };
      };
      const alice = await mk(parent, "alice", true);
      const olive = await mk(child, "olive", true);
      const carol = await mk(child, "carol");
      const post = (path: string, init: RequestInit & { cookie?: string } = {}) =>
        fetch(`${cs.url}${path}`, { method: "POST", redirect: "manual", ...init, headers: { origin, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as object) } });

      // Password sign-in (the API door) and sign-out.
      const pw = await post("/api/v1/sessions", { headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "carol", password: "a-long-family-passphrase" }) });
      expect(pw.status).toBe(201);
      take("password sign-in", pw, "forge_session");
      const out = await post("/logout", { cookie: `forge_session=${createSession(child.db, carol.id).token}` });
      take("sign-out", out, "forge_session");

      // The mode switch lets go of forge_mode.
      const mode = await fetch(`${cs.url}/?mode=dev`, { redirect: "manual" });
      expect(mode.status).toBe(303);
      take("mode switch", mode, "forge_mode");

      // The theme choice.
      take("theme", await post("/theme", { cookie: carol.cookie, body: new URLSearchParams({ theme: "dark" }) }), "forge_theme");

      // Passkey: enrol with a session, then sign in without one.
      const d = await device(origin);
      const jsonPost = (path: string, body: unknown, cookie?: string) =>
        post(path, { ...(cookie ? { cookie } : {}), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const opts = (await (await jsonPost("/settings/passkeys/options", {}, carol.cookie)).json()) as { challenge: string };
      const added = await jsonPost("/settings/passkeys", { name: "k", challenge: opts.challenge, ...(await d.create(opts.challenge)) }, carol.cookie);
      expect(added.status).toBe(200);
      const o = (await (await jsonPost("/signin/passkey/options", {})).json()) as { challenge: string };
      const pk = await jsonPost("/signin/passkey", { challenge: o.challenge, ...(await d.get(o.challenge)) });
      expect(pk.status).toBe(200);
      take("passkey sign-in", pk, "forge_session");

      // Recovery link: a new passkey registered from the emailed link signs in.
      markVerified(child.db, carol.id, new Date().toISOString());
      const token = issueRecovery(child.db, carol.id, Date.now())!;
      const rd = await device(origin);
      const ro = (await (await jsonPost("/recover/options", { token })).json()) as { challenge: string };
      const recovered = await jsonPost("/recover/passkey", { token, name: "r", challenge: ro.challenge, ...(await rd.create(ro.challenge)) });
      expect(recovered.status).toBe(200);
      take("recovery-link passkey", recovered, "forge_session");

      // Parent sign-in: link carol to alice at the parent, then sign in through it.
      const consent = async (start: Response) => {
        const to = new URL(start.headers.get("location")!);
        const res = await fetch(`${ps.url}/oauth/authorize`, {
          method: "POST", redirect: "manual",
          headers: { cookie: alice.cookie, origin: ps.url },
          body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
        });
        return new URL(res.headers.get("location")!);
      };
      const callback = (url: URL, cookie: string) => fetch(`${cs.url}${url.pathname}${url.search}`, { redirect: "manual", headers: { cookie } });
      const link = await post("/settings/parent/link", { cookie: carol.cookie });
      expect(link.status).toBe(303);
      const linkState = take("parent link start", link, "forge_rp");
      const linked = await callback(await consent(link), `${carol.cookie}; ${cookieOf(linkState, "forge_rp")}`);
      take("parent link callback", linked, "forge_rp", "forge_flash");
      const start = await fetch(`${cs.url}/signin/parent`, { redirect: "manual" });
      const state = take("parent sign-in start", start, "forge_rp");
      const done = await callback(await consent(start), cookieOf(state, "forge_rp"));
      expect(done.status).toBe(303);
      const finished = take("parent sign-in", done, "forge_session", "forge_rp");
      expect(cookieOf(finished, "forge_session").length).toBeGreaterThan("forge_session=".length);

      // An app host's grant and its sign-out, through a live apps runtime.
      const runtime = new AppsRuntime(child, { domain: "apps.test", scheme: https ? "https" : "http", publicPort: cs.port, forgeUrl: cs.url, concurrency: 1 });
      await runtime.start();
      stops.push(() => runtime.stop());
      const made = await newApp(child, olive.user, { name: "cookiegrant", visibility: "private" });
      if (!made.ok) throw new Error(made.error);
      const target = { app: made.value.app, env: "production" as const };
      const via = (path: string) =>
        fetch(`${cs.url}${path}`, { redirect: "manual", headers: { host: "cookiegrant.apps.test", ...(https ? { "x-forwarded-proto": "https" } : {}) } });
      const grant = await via(`/__forge/grant?t=${encodeURIComponent(signGrant(child.config.dataDir, target, 60_000))}&to=/`);
      expect(grant.status).toBe(303);
      take("app grant", grant);
      take("app sign-out", await via("/__forge/signout"));

      expect(new Set(seen.map((c) => c.split("=")[0])).size).toBeGreaterThanOrEqual(5);
    });
  });
}

describe("cookie-setting sites", () => {
  test("every file's cookie sites are walked above or named, counted exactly", async () => {
    const found: Record<string, number> = {};
    for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
      const text = await Bun.file(file).text();
      const n = (text.match(/["']set-cookie["']|Set-Cookie|sessionCookie\(/gi) ?? []).length;
      if (n > 0) found[file] = n;
    }
    const expected: Record<string, number> = { ...WALKED };
    for (const [file, { sites }] of Object.entries(UNREACHED)) expected[file] = sites;
    expect(found).toEqual(expected);
    for (const { why } of Object.values(UNREACHED)) expect(why.length).toBeGreaterThan(10);
  });
});

/**
 * The doors above prove the cookies a request can reach; this walk proves the
 * rest (#10968). Every cookie spelled in src/ (`name=value; Attribute`, outside
 * comments) says HttpOnly, SameSite=Lax|Strict and Secure (literal, or
 * conditioned on `secureFor`'s https rule), unless its name is on EXEMPT.
 */

/**
 * Cookies allowed to go without a flag, by name as the source spells it, one
 * line of reason each. Empty today: every cookie has every flag. A cookie a
 * first-party script must read (a theme painted before the server answers,
 * say) would go here; the session and any credential cookie never do.
 */
const EXEMPT: Record<string, string> = {};

/** Names that carry a credential: never exempt, whatever the list says. */
const NEVER_EXEMPT = /session|token|grant|state|visitor/i;

/**
 * What a `set-cookie` writer may pass when it is not an inline literal: a
 * builder whose own literal the walk checks, or a variable holding one.
 */
const BUILDERS: Record<string, string> = {
  "sessionCookie(": "src/web/pages/site.ts",
  "flashCookie(": "src/web/flash.ts",
  "clearFlashCookie(": "src/web/flash.ts",
  "cookieHeader(": "src/http/rp.ts",
  "visitorCookie(": "src/apps/feedback.ts",
  clear: "src/http/rp.ts, `cookieHeader` with Max-Age 0",
  value: "src/apps/scaffold.ts, `redirectTo`'s cookies, each from `cookie`",
  cookie: "src/http/measure.ts, the line `trackVisitor` returns, built by `cookieLine` in src/perf/visitor_id.ts",
  "dropGift(": "src/web/gift_cookie.ts, the gift cookie cleared with Max-Age 0",
  "o.cookie": "src/web/layout.ts, a page's cookie (the theme literal in src/web/pages/site.ts)",
};

/** `name=value; Attribute`: a cookie spelled out, its name literal or `${…}`. */
const SPELLED = /(\$\{[^}]+\}|[A-Za-z_][\w-]*)=[^;\n]*?;\s*(?:Path|Max-Age|Expires|Domain|HttpOnly|SameSite|Secure)\b/;

/** The flags a cookie line lacks; empty when it has them all. */
function lacking(line: string): string[] {
  const lacks: string[] = [];
  if (!/\bHttpOnly\b/.test(line)) lacks.push("HttpOnly");
  if (!/\bSameSite=(?:Lax|Strict)\b/.test(line)) lacks.push("SameSite=Lax|Strict");
  // Literal, conditional (`? "; Secure" : ""`), or the `${secure}` a builder took from secureFor.
  if (!/\bSecure\b|\$\{secure\}/.test(line)) lacks.push("Secure");
  return lacks;
}

describe("cookie flags, walked in the source", () => {
  const files = [...new Bun.Glob("src/**/*.ts").scanSync(".")].sort().map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const spelled = files.flatMap(({ file, text }) =>
    text.split("\n").flatMap((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return [];
      const match = SPELLED.exec(line);
      return match ? [{ where: `${file}:${i + 1}`, name: match[1]!, line: trimmed }] : [];
    }),
  );

  test("the walk finds the forge's cookies, including those no door above reaches", () => {
    const where = new Set(spelled.map((s) => s.where.replace(/:\d+$/, "")));
    for (const file of ["src/web/pages/site.ts", "src/web/flash.ts", "src/http/rp.ts", "src/http/server.ts", "src/apps/proxy.ts", "src/apps/feedback.ts", "src/web/pages/map.ts"])
      expect([file, where.has(file)]).toEqual([file, true]);
  });

  test("every cookie spelled in src/ is HttpOnly, SameSite and Secure, or exempt with a reason", () => {
    const short = spelled
      .filter((s) => EXEMPT[s.name] === undefined)
      .map((s) => ({ ...s, lacks: lacking(s.line) }))
      .filter((s) => s.lacks.length > 0)
      .map((s) => `${s.where} ${s.name} lacks ${s.lacks.join(", ")}`);
    expect(short).toEqual([]);
  });

  test("every set-cookie writer passes a checked literal or a known builder", () => {
    const writer = /(?:\.(?:append|set)\(\s*["']set-cookie["']\s*,|["']set-cookie["']\s*:)\s*([^\n]+)/gi;
    const unknown: string[] = [];
    let writers = 0;
    for (const { file, text } of files) {
      for (const match of text.matchAll(writer)) {
        writers++;
        const value = match[1]!.trim();
        const at = `${file}:${text.slice(0, match.index).split("\n").length}`;
        if (value.startsWith("`")) {
          const lacks = SPELLED.test(value) ? lacking(value) : ["every flag"];
          if (lacks.length > 0) unknown.push(`${at} inline cookie lacks ${lacks.join(", ")}`);
          continue;
        }
        const known = Object.keys(BUILDERS).some((b) =>
          b.endsWith("(") ? value.startsWith(b) : new RegExp(`^${b.replace(".", "\\.")}\\b`).test(value),
        );
        if (!known) unknown.push(`${at} passes \`${value}\`: build it with a checked builder or spell it inline`);
      }
    }
    expect(writers).toBeGreaterThan(10);
    expect(unknown).toEqual([]);
  });

  test("the exempt list holds no credential cookie and nothing stale", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect([name, NEVER_EXEMPT.test(name)]).toEqual([name, false]);
      expect(reason.trim().length).toBeGreaterThan(10);
      expect([name, spelled.some((s) => s.name === name)]).toEqual([name, true]);
    }
  });
});
