/**
 * Every cookie the forge sets (#5898): sign in by each door and read every
 * Set-Cookie. HttpOnly and SameSite=Lax|Strict on each, and Secure whenever
 * the public origin is https. Run for a forge on http and one declared https.
 * The walk at the end checks every cookie spelled in src/, reached or not (#10968).
 * Each cookie is scoped to `Path=/` unless COOKIES names a narrower path and
 * why, and a new place that writes one fails here with its file and line (#11864).
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
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { mintFirstAdmin } from "../src/core/first_admin.ts";
import { createIssue } from "../src/core/issues.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { recordStart } from "../src/core/starts.ts";
import { mintClaim } from "../src/spawn/claim.ts";
import { issueRecovery, markVerified } from "../src/core/verify.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setReturning } from "../src/settings/returning.ts";
import { quietLogs } from "./helpers/globals.ts";
import { device, passkeyFields } from "./helpers/passkey.ts";

quietLogs();
setDefaultTimeout(60_000);

/**
 * Every cookie spelled in src/ (`name=value; Attribute`, see SPELLED below),
 * keyed by its file and its name as the source spells it, with how many lines
 * spell it there. `name` is what a browser sees (a RegExp when the name carries
 * the thing it is for); `door` is the walk above that drives it, or `why` says
 * why no walk does. `path` is set only where a cookie is narrower than `/`,
 * with its reason: a narrower path is stricter, never weaker.
 */
interface Spelled {
  name: string | RegExp;
  lines: number;
  door?: string;
  why?: string;
  path?: { path: string; why: string };
}
const COOKIES: Record<string, Spelled> = {
  "src/web/pages/site.ts forge_session": { name: "forge_session", lines: 1, door: "password sign-in" },
  "src/web/pages/site.ts forge_theme": { name: "forge_theme", lines: 2, door: "theme" },
  "src/web/flash.ts ${FLASH_COOKIE}": { name: "forge_flash", lines: 2, door: "parent link callback" },
  "src/http/server.ts forge_mode": { name: "forge_mode", lines: 1, door: "mode switch" },
  "src/http/rp.ts ${STATE_COOKIE}": {
    name: "forge_rp",
    lines: 1,
    door: "parent sign-in start",
    path: { path: "/signin/parent", why: "the OpenID state is read only by /signin/parent/callback; no other page should carry it" },
  },
  "src/apps/proxy.ts ${grantCookieName(target)}": { name: /^forge_grant_[0-9a-z]{8}$/, lines: 2, door: "app grant" },
  "src/apps/feedback.ts ${VISITOR_COOKIE}": { name: "forge_visitor", lines: 1, door: "app note" },
  "src/perf/visitor_id.ts ${COOKIE}": { name: "forge_visitor", lines: 1, door: "page-view beacon" },
  "src/web/gift_cookie.ts ${NAME}": { name: "forge_gift", lines: 2, door: "gift link" },
  "src/web/pages/map.ts ${name}": { name: /^rm_[\w-]+$/, lines: 1, door: "roadmap" },
  "src/web/pages/pricing.ts ${COOKIE}": {
    name: "forge_order",
    lines: 1,
    why: "a paid order needs a payment provider to answer placeOrder; HttpOnly, Lax, Secure over https, checked in the source walk",
    path: { path: "/pricing", why: "the order ticket is read only by /pricing pages; no other page should carry it" },
  },
};

/** The entry for a cookie by the name a browser sees, if one names it. */
const entryFor = (name: string): Spelled | undefined =>
  Object.values(COOKIES).find((c) => (typeof c.name === "string" ? c.name === name : c.name.test(name)));

/**
 * Cookie-setting sites, counted per file (imports included) as `set-cookie` headers and
 * sessionCookie() calls. WALKED files have every site exercised above (by the
 * door named); UNREACHED ones are named with why. The scan below compares
 * these counts to the source exactly and names the lines of any file that
 * differs, so a new site fails until it is walked here or named.
 */
const WALKED: Record<string, number> = {
  "src/http/api/tokens.ts": 4, // password sign-in, sign-out: a set-cookie header and a sessionCookie() call each
  "src/http/server.ts": 1, // the mode switch
  "src/http/rp.ts": 6, // parent sign-in and link: state cookie set and cleared
  "src/apps/proxy.ts": 2, // app grant, app sign-out
  "src/apps/feedback.ts": 2, // a stranger's note on an app host, both answers that may carry the visitor cookie
  "src/web/pages/passkeys.ts": 5, // import, passkey sign-in, passkey add/recovery-link sign-in, access-link sign-in (+1 mention)
  "src/web/pages/site.ts": 4, // sessionCookie() itself and its uses: password sign-in/sign-up, logout; the theme cookie
  "src/web/pages/first-admin.ts": 1, // the first admin made by passkey
  "src/web/pages/signup-passkey.ts": 2, // import, sign-up by passkey
  "src/web/pages/map.ts": 1, // the roadmap's last-looked cookie
  "src/web/layout.ts": 4, // the flash set on, and cleared from, a redirect
  "src/web/flash.ts": 2, // forge_flash
  "src/web/gift_cookie.ts": 1, // the gift link keeps its code
  "src/web/pages/claim.ts": 1, // the claim link of a spawned forge
  "src/web/pages/start_claim.ts": 1, // an agent's start taken with a new account
  "src/web/pages/everyday.ts": 2, // the everyday account made, and the switch that ends the admin's session
  "src/http/measure.ts": 1, // the page-view beacon
  "src/http/visitor.ts": 1, // the doc comment of trackVisitor, whose line the beacon sends
  "src/perf/visitor_id.ts": 1, // the doc comment of cookieLine, whose line the beacon sends
};
const UNREACHED: Record<string, { sites: number; why: string }> = {
  "src/http/addressed.ts": { sites: 1, why: "only asks whether a response sets a cookie, so it isn't shared; it sets none" },
  "src/release/journey.ts": { sites: 1, why: "reads the Set-Cookie of the sign-in response to carry the session through the walk; sets none; covered by test/release-journey.test.ts" },
  "src/web/pages/new-forge.ts": { sites: 1, why: "appends dropGift(), the gift cookie's clearing line from src/web/gift_cookie.ts, once a forge is made with a gift code" },
};

const dirs: string[] = [];
const stops: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cookies-"));
  dirs.push(dir);
  return dir;
};

/** Each door's label and the cookie names it set, over http and https: what the coverage test reads. */
const driven = new Map<string, Set<string>>();

function check(label: string, cookies: string[], https: boolean) {
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    const flags = cookie.split(";").slice(1).map((f) => f.trim().toLowerCase());
    const name = cookie.split("=")[0]!;
    const where = `${label}: ${name}`;
    const entry = entryFor(name);
    expect([where, entry === undefined ? "a cookie COOKIES does not name" : "named"]).toEqual([where, "named"]);
    // A cookie a page script must read goes on EXEMPT with its reason; none does today.
    if (EXEMPT[name] === undefined) expect([where, flags.includes("httponly")]).toEqual([where, true]);
    expect([where, flags.includes("samesite=lax") || flags.includes("samesite=strict")]).toEqual([where, true]);
    expect([where, flags.includes("secure")]).toEqual([where, https]);
    // Exactly one Path, and it is `/` unless the entry scopes it narrower.
    expect([where, flags.filter((f) => f.startsWith("path="))]).toEqual([where, [`path=${(entry?.path?.path ?? "/").toLowerCase()}`]]);
    driven.set(label, (driven.get(label) ?? new Set()).add(name));
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

      // Sign-up by passkey: a new account, signed in.
      const sd = await device(origin);
      const so = (await (await jsonPost("/signup/passkey/options", { username: "wren", email: "" })).json()) as { challenge: string };
      const signedUp = await jsonPost("/signup/passkey", { username: "wren", email: "", challenge: so.challenge, ...(await sd.create(so.challenge)) });
      expect(signedUp.status).toBe(201);
      take("passkey sign-up", signedUp, "forge_session");

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
      const callback = (url: URL, cookie: string) => {
        // The state cookie's narrower Path must still reach the callback that reads it.
        expect(url.pathname.startsWith(COOKIES["src/http/rp.ts ${STATE_COOKIE}"]!.path!.path)).toBe(true);
        return fetch(`${cs.url}${url.pathname}${url.search}`, { redirect: "manual", headers: { cookie } });
      };
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

      // A stranger's note from a public app's page: the anonymous visitor cookie.
      const noted = await newApp(child, olive.user, { name: "cookienote", visibility: "public" });
      if (!noted.ok) throw new Error(noted.error);
      const scheme = https ? "https" : "http";
      const note = await fetch(`${cs.url}/__forge/note`, {
        method: "POST",
        redirect: "manual",
        headers: {
          host: "cookienote.apps.test",
          origin: `${scheme}://cookienote.apps.test`,
          "content-type": "application/json",
          ...(https ? { "x-forwarded-proto": "https" } : {}),
        },
        body: JSON.stringify({ text: "The cookie note", page: `${scheme}://cookienote.apps.test/`, viewport: "390x844" }),
      });
      expect(note.status).toBe(201);
      take("app note", note, "forge_visitor");

      // A gift link keeps its code in a cookie, out of the next address.
      const gift = await fetch(`${cs.url}/?code=gift-cookie-1`, { redirect: "manual" });
      expect(gift.status).toBe(303);
      take("gift link", gift, "forge_gift");

      // The page-view beacon gives a returning-visitor id when the forge counts them.
      setReturning(child.db, true, olive.id);
      const beacon = await fetch(`${cs.url}/_measure`, {
        method: "POST",
        headers: { origin, "user-agent": CHROME, "accept-language": "en-GB" },
        body: JSON.stringify({ path: "/", ttfb: 40, load: 300, lcp: 250, inp: 80, cls: 0.02 }),
      });
      expect(beacon.status).toBe(204);
      take("page-view beacon", beacon, "forge_visitor");

      // The roadmap of a public repository with a pillar marks when it was last looked at.
      const repo = await createRepo(child, olive.user, { name: "cookiemap", visibility: "public" });
      if (!repo.ok) throw new Error(String(repo.error));
      const issue = (title: string) => {
        const made = createIssue(child.db, { repoId: repo.value.id, authorId: olive.id, title, body: "" });
        if (!made.ok) throw new Error(made.error);
        return made.value;
      };
      if (!addDependency(child.db, issue("P0 Trust: contained"), issue("Work"), olive.id).ok) throw new Error("dependency");
      const map = await fetch(`${cs.url}/olive/cookiemap/map`, { redirect: "manual" });
      expect(map.status).toBe(200);
      take("roadmap", map, "rm_olive_cookiemap");

      // The first admin of a forge with none, made by passkey from a one-time code.
      const lone = createApp({ dataDir: await tmp(), port: 0, ...(public_ ? { url: public_ } : {}) });
      const ls: Servers = await serve(lone);
      stops.push(() => ls.stop());
      const loneOrigin = public_ ?? ls.url;
      const who = { token: mintFirstAdmin(lone.db)!.code, username: "ada", email: "ada@x.test" };
      const fields = await passkeyFields(ls.url, "/first-admin/options", who, { headers: { origin: loneOrigin }, device: await device(loneOrigin) });
      const first = await fetch(`${ls.url}/first-admin`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: loneOrigin },
        body: new URLSearchParams({ ...who, ...fields }),
      });
      expect(first.status).toBe(303);
      take("first admin", first, "forge_session");

      // A spawned forge's claim link, seeded as spawn leaves it (test/claim-link.test.ts
      // walks the whole spawn): an org with a placeholder founder, parent.json, a live link.
      const kinDir = await tmp();
      const kin = createApp({ dataDir: kinDir, port: 0, ...(public_ ? { url: public_ } : {}) });
      const ks: Servers = await serve(kin);
      stops.push(() => ks.stop());
      const kinOrigin = public_ ?? ks.url;
      const founder = await mk(kin, "founder");
      const org = createOrg(kin.db, "kin", founder.id);
      if (!org.ok) throw new Error(org.error);
      await Bun.write(join(kinDir, "parent.json"), JSON.stringify({ org: "kin" }));
      const kinPost = (path: string, form: Record<string, string>, cookie?: string) =>
        fetch(`${ks.url}${path}`, { method: "POST", redirect: "manual", headers: { origin: kinOrigin, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form) });
      const claimed = await kinPost("/claim", { token: mintClaim(kin.db, org.value.id), username: "kin-owner", email: "k@x.test", password: "a-long-claim-passphrase" });
      expect(claimed.status).toBe(303);
      const owner = cookieOf(take("claim link", claimed, "forge_session"), "forge_session");

      // The everyday account made from the admin's, then the switch back to sign-in.
      const daily = { username: "kin-me", email: "me@x.test" };
      const dailyKey = await passkeyFields(ks.url, "/settings/everyday/options", daily, { headers: { origin: kinOrigin, cookie: owner }, device: await device(kinOrigin) });
      const everyday = await kinPost("/settings/everyday", { ...daily, ...dailyKey }, owner);
      expect(everyday.status).toBe(303);
      take("everyday account", everyday, "forge_session");
      const switched = await kinPost("/settings/everyday/switch", {}, owner);
      expect(switched.status).toBe(303);
      take("everyday switch", switched, "forge_session");

      // An agent's start, taken by a stranger who makes an account on the spot.
      const agent = await mk(kin, "agent-start");
      const startToken = "claim_cookie-flags-start";
      recordStart(kin.db, agent.id, startToken, "cookie-flags");
      const started = await kinPost(`/claim/start/${startToken}/account`, { username: "taker", email: "t@x.test", password: "a-long-start-passphrase" });
      expect(started.status).toBe(303);
      take("start claim", started, "forge_session");

      expect(new Set(seen.map((c) => c.split("=")[0])).size).toBeGreaterThanOrEqual(5);
    });
  });
}

describe("cookie-setting sites", () => {
  test("every file's cookie sites are walked above or named, counted exactly; a stray one is named by file and line", async () => {
    const SITE = /["']set-cookie["']|Set-Cookie|sessionCookie\(/gi;
    const found: Record<string, string[]> = {};
    for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
      const lines = (await Bun.file(file).text()).split("\n");
      lines.forEach((line, i) => {
        const at = `${file}:${i + 1}`;
        (found[file] ??= []).push(...[...line.matchAll(SITE)].map(() => at));
      });
    }
    const expected: Record<string, number> = { ...WALKED };
    for (const [file, { sites }] of Object.entries(UNREACHED)) expected[file] = sites;
    const off = [...new Set([...Object.keys(found), ...Object.keys(expected)])]
      .sort()
      .filter((file) => (found[file]?.length ?? 0) !== (expected[file] ?? 0))
      .map((file) => `${file}: ${found[file]?.length ?? 0} sites, the test names ${expected[file] ?? 0} (${(found[file] ?? []).join(", ") || "none left"})`);
    expect(off).toEqual([]);
    for (const { why } of Object.values(UNREACHED)) expect(why.length).toBeGreaterThan(10);
  });

  test("every cookie COOKIES names was set by a door above, or says why no door reaches it", () => {
    // Run alone (`-t`), no door has run: there is nothing to compare.
    if (driven.size === 0) return;
    const wrong: string[] = [];
    const sets = (door: string | undefined, c: Spelled) =>
      [...(door === undefined ? [...driven.values()].flatMap((n) => [...n]) : (driven.get(door) ?? []))].some((n) =>
        typeof c.name === "string" ? c.name === n : c.name.test(n),
      );
    for (const [key, c] of Object.entries(COOKIES)) {
      if (c.door !== undefined && c.why !== undefined) wrong.push(`${key}: a door or a why, not both`);
      if (c.door !== undefined && !sets(c.door, c)) wrong.push(`${key}: the door "${c.door}" did not set ${c.name}`);
      if (c.door === undefined && sets(undefined, c)) wrong.push(`${key}: a door sets ${c.name}; name it and drop the why`);
      if (c.door === undefined && (c.why ?? "").length <= 10) wrong.push(`${key}: no door and no why`);
      if (c.path !== undefined && (c.path.path === "/" || !c.path.path.startsWith("/") || c.path.why.length <= 10))
        wrong.push(`${key}: a narrower path names itself and its reason`);
    }
    expect(wrong).toEqual([]);
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

/** The flags a cookie line lacks; empty when it has them all. `path` is the Path it must name. */
function lacking(line: string, path = "/"): string[] {
  const lacks: string[] = [];
  const paths = [...line.matchAll(/\bPath=([^;\s`"']*)/g)].map((m) => m[1]);
  if (paths.length !== 1 || paths[0] !== path) lacks.push(`Path=${path}`);
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

  test("every cookie spelled in src/ has its entry in COOKIES, and no entry is stale", () => {
    const counts = new Map<string, string[]>();
    for (const s of spelled) {
      const key = `${s.where.replace(/:\d+$/, "")} ${s.name}`;
      counts.set(key, [...(counts.get(key) ?? []), s.where]);
    }
    const wrong: string[] = [];
    for (const [key, at] of counts) {
      const entry = COOKIES[key];
      if (entry === undefined) wrong.push(`${at.join(", ")}: a cookie \`${key.split(" ")[1]}\` with no entry in COOKIES`);
      else if (entry.lines !== at.length) wrong.push(`${at.join(", ")}: ${at.length} lines spell \`${key}\`, COOKIES says ${entry.lines}`);
    }
    for (const key of Object.keys(COOKIES)) if (!counts.has(key)) wrong.push(`${key}: in COOKIES but spelled nowhere in src/`);
    expect(wrong).toEqual([]);
  });

  test("the walk finds the forge's cookies, including those no door above reaches", () => {
    const where = new Set(spelled.map((s) => s.where.replace(/:\d+$/, "")));
    for (const file of ["src/web/pages/site.ts", "src/web/flash.ts", "src/http/rp.ts", "src/http/server.ts", "src/apps/proxy.ts", "src/apps/feedback.ts", "src/web/pages/map.ts"])
      expect([file, where.has(file)]).toEqual([file, true]);
  });

  test("every cookie spelled in src/ is HttpOnly, SameSite and Secure, or exempt with a reason", () => {
    const short = spelled
      .filter((s) => EXEMPT[s.name] === undefined)
      .map((s) => ({ ...s, lacks: lacking(s.line, COOKIES[`${s.where.replace(/:\d+$/, "")} ${s.name}`]?.path?.path ?? "/") }))
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
          const spelledName = SPELLED.exec(value)?.[1];
          const lacks = spelledName !== undefined ? lacking(value, COOKIES[`${file} ${spelledName}`]?.path?.path ?? "/") : ["every flag"];
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
