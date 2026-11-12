/**
 * The screens a signed-out person passes on the way to their own forge show
 * none of the words a stranger is never shown (#11172, docs/DESIGN.md § The
 * first five minutes). The list is `STRANGER_NEVER_SEES`, imported, not copied.
 * Only visible text is read: not attributes, URLs or scripts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBuilding } from "../src/actions/start.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { STRANGER_NEVER_SEES } from "../src/design/first_five_minutes.ts";
import { restoreClaim, revokeClaim, spawnedOrg } from "../src/spawn/claim.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { claimedForge, startedForge, type ClaimedForge, type StartedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const BANNED = new RegExp(`(?<![A-Za-z0-9_])(?:${STRANGER_NEVER_SEES.join("|")})(?:s|ed|ing)?(?![A-Za-z0-9_])`, "gi");

/** The text a person reads in `<main>` (or the whole page when there is none), as sentences. */
function visibleSentences(html: string): string[] {
  const main = /<main\b[\s\S]*?<\/main>/.exec(html)?.[0] ?? html;
  return main
    .replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** `screen: "sentence"` for every banned word on a screen. */
function bannedIn(screen: string, html: string): string[] {
  return visibleSentences(html)
    .filter((s) => new RegExp(BANNED.source, "i").test(s))
    .map((s) => `${screen}: "${s}"`);
}

test("the finder names the screen and the sentence", () => {
  expect(bannedIn("demo", "<main><p>Fine words. Your child forge.</p><a href='/claim'>ok</a></main>")).toEqual([`demo: "Your child forge."`]);
  expect(bannedIn("demo", `<main><a href="/claim" title="claim">Open</a></main>`)).toEqual([]);
});

describe("a stranger's way to their own forge", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let token = "";
  let cookie = "";
  let fresh: StartedForge;
  let claimed: ClaimedForge;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-stranger-words-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.test", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error("user");
    cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
    servers = await serve(app);
    const made = await startBuilding(app, { name: "words" }, "203.0.113.9", servers.url);
    if (!made.ok) throw new Error(made.error.error);
    token = made.value.claim.url.split("/").pop()!;
    fresh = await startedForge("forge-stranger-fresh-");
    claimed = await claimedForge("forge-stranger-claimed-");
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
    await fresh.stop();
    await claimed.stop();
  });

  test("every screen is free of the banned words", async () => {
    const get = async (base: string, path: string, cookie = "") => {
      const r = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
      expect(r.status).toBe(200);
      return r.text();
    };
    const plan = async (keepAccess: boolean) => {
      const r = await fetch(`${servers.url}/forges/new`, {
        method: "POST",
        headers: { cookie, origin: "https://forge.test" },
        body: new URLSearchParams({ name: "planned", do: "plan", fresh: "a small bakery site", ...(keepAccess ? { keepAccess: "on" } : {}) }),
      });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('id="plan"');
      return html;
    };
    const screens: [string, string][] = [
      ["the anonymous home (/)", await get(servers.url, "/")],
      ["the new-forge form (/forges/new)", await get(servers.url, "/forges/new")],
      ["the start claim screen (/claim/start/:token)", await get(servers.url, `/claim/start/${token}`)],
      ["the claim screen of a new forge (/claim)", await get(fresh.base, "/claim")],
      ["the account screen of a new forge (/welcome)", await get(fresh.base, "/welcome")],
      ["the plan step, leaving (/forges/new)", await plan(false)],
      ["the plan step, keeping access (/forges/new)", await plan(true)],
      ["the first-login next steps (/)", await get(claimed.base, "/", claimed.owner)],
    ];
    const found = screens.flatMap(([name, html]) => bannedIn(name, html));
    expect(found).toEqual([]);
  });

  // Runs after the screens above: it spends the new forge's link, state by state.
  test("the claim screen's refusals are free of the banned words", async () => {
    const db = fresh.child.db;
    const org = (await spawnedOrg(fresh.child))!.org.id;
    const submit = async (status: number, form: Record<string, string>) => {
      const r = await fetch(`${fresh.base}/claim`, { method: "POST", headers: { origin: fresh.base }, body: new URLSearchParams(form), redirect: "manual" });
      expect(r.status).toBe(status);
      return r.text();
    };
    // The passkey note shows what /claim/options says, as text.
    const note = async (status: number, body: Record<string, string>) => {
      const r = await fetch(`${fresh.base}/claim/options`, { method: "POST", headers: { "content-type": "application/json", origin: fresh.base }, body: JSON.stringify(body) });
      expect(r.status).toBe(status);
      return `<main><p>${((await r.json()) as { message: string }).message}</p></main>`;
    };
    const stored = () => db.query<{ value: string }, []>("SELECT value FROM user_setting WHERE key = 'spawn_claim'").get()!.value;
    const setStored = (v: string) => db.query("UPDATE user_setting SET value = ?1 WHERE key = 'spawn_claim'").run(v);
    const live = stored();
    const as = (patch: Record<string, string>) => setStored(JSON.stringify({ ...JSON.parse(live), ...patch }));
    const who = { token: fresh.token, username: "maria", email: "maria@bakery.test" };
    const screens: [string, string][] = [];
    const both = async (state: string, status: number) => {
      screens.push([`/claim, ${state}`, await submit(status, { ...who, password: "a-long-enough-password" })]);
      screens.push([`/claim passkey note, ${state}`, await note(status, who)]);
    };

    screens.push(["/claim, unknown", await submit(404, { ...who, token: "nope", password: "a-long-enough-password" })]);
    screens.push(["/claim passkey note, unknown", await note(404, { ...who, token: "nope" })]);
    screens.push(["/claim, a passkey that failed", await submit(422, { ...who, challenge: "x", clientDataJSON: "x", attestationObject: "x" })]);
    expect(revokeClaim(db, org)).toBe(true);
    await both("revoked", 410);
    expect(restoreClaim(db, org)).toBe(true);
    as({ e: "2000-01-01T00:00:00.000Z" });
    await both("expired", 410);
    as({ u: new Date().toISOString() });
    await both("used", 410);
    setStored(live);
    const admin = await createUser(db, { origin: "seed", trusted: true, username: "someone", email: "s@f.test", password: "a-good-passphrase", isAdmin: true });
    if (!admin.ok) throw new Error("admin");
    await both("owned", 410);

    const found = screens.flatMap(([name, html]) => bannedIn(name, html));
    expect(found).toEqual([]);
  });
});
