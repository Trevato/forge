/**
 * The pieces of a stranger's first five minutes (#11948) that a page test
 * does not reach: taking the forge's own name, the credit a run is given, the
 * terminal's words and the phone's top bar.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, Jwk } from "../src/auth/webauthn.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser } from "../src/core/users.ts";
import { becomeOrg } from "../src/spawn/claim.ts";
import { cappedByLent, keepFunding, lentCreditLeft, runEnded } from "../src/spawn/funding.ts";
import { closedSignupText } from "../src/tui/screens/signin.ts";
import { terminalLine } from "../src/web/ui.ts";
import { components as componentsCss } from "../src/web/style/components.ts";
import { startedForge, type StartedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let founderId = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "first-five-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "parent.json"), "{}");
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "founder", email: "f@x.test", password: "a-long-enough-password" });
  if (!made.ok) throw new Error("user");
  founderId = made.value.id;
});
afterAll(async () => {
  delete process.env["FORGE_PARENT_LOCAL"];
  await rm(dir, { recursive: true, force: true });
});

const org = (name: string): string => {
  const made = createOrg(app.db, name, founderId);
  if (!made.ok) throw new Error(made.error);
  return made.value.id;
};
const row = (id: string) => app.db.query<{ kind: string; is_admin: number; email: string }, [string]>("SELECT kind, is_admin, email FROM user WHERE id = ?").get(id)!;

test("becomeOrg turns the organisation into an admin account and drops any session it held", () => {
  const id = org("marias");
  app.db.query("INSERT INTO session (token_hash, user_id, expires_at) VALUES ('h1', ?1, '2999-01-01T00:00:00Z')").run(id);
  expect(becomeOrg(app.db, id, { hash: "x", email: "m@x.test" })).toBe("ok");
  expect(row(id)).toEqual({ kind: "user", is_admin: 1, email: "m@x.test" });
  expect(app.db.query("SELECT 1 FROM session WHERE user_id = ?").get(id)).toBeNull();
});

test("becomeOrg is gone once the row is no longer an organisation", () => {
  const id = org("bakery");
  expect(becomeOrg(app.db, id, { hash: "x", email: "b@x.test" })).toBe("ok");
  expect(becomeOrg(app.db, id, { hash: "y", email: "b2@x.test" })).toBe("gone");
});

test("becomeOrg refuses an address another account holds, and changes nothing", () => {
  const id = org("shop");
  expect(becomeOrg(app.db, id, { hash: "x", email: "f@x.test" })).toBe("email_taken");
  expect(row(id).kind).toBe("org");
});

test("becomeOrg keeps the passkey given, and a refused passkey leaves the organisation as it was", () => {
  const key: Jwk = { kty: "EC", crv: "P-256", x: "AAAA", y: "AAAA" };
  const credential: Credential = { id: "cred-1", alg: "ES256", key, signCount: 0 };
  const a = org("vault");
  expect(becomeOrg(app.db, a, { hash: "", email: "k@x.test", credential })).toBe("ok");
  expect(app.db.query("SELECT count(*) AS n FROM passkey WHERE user_id = ?").get(a)).toEqual({ n: 1 });
  const b = org("lockbox");
  expect(becomeOrg(app.db, b, { hash: "", email: "k2@x.test", credential })).toBe("gone");
  expect(row(b).kind).toBe("org");
});

test("a run on lent credit is budgeted at most what is left of it", () => {
  keepFunding(dir, { token: "maria.bearer-token", capUsd: 2, spentUsd: 0.5 });
  expect(lentCreditLeft(true, dir)).toBe(1.5);
  expect(lentCreditLeft(false, dir)).toBeUndefined();
  expect(cappedByLent(5, lentCreditLeft(true, dir))).toBe(1.5);
  expect(cappedByLent(1, lentCreditLeft(true, dir))).toBe(1);
  expect(cappedByLent(5, lentCreditLeft(false, dir))).toBe(5);
});

test("a run's end asks the host what it counted, only when this forge is funded", async () => {
  process.env["FORGE_PARENT_LOCAL"] = "http://127.0.0.1:1";
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ capUsd: 2, spentUsd: 1 }));
  };
  const asking = runEnded(app, fetcher);
  expect(asking).toBeDefined();
  await asking;
  expect(asked).toEqual(["http://127.0.0.1:1/api/v1/credit"]);
  const bare = createApp({ dataDir: await mkdtemp(join(tmpdir(), "first-five-bare-")), port: 0 });
  expect(runEnded(bare, fetcher)).toBeUndefined();
  await rm(bare.config.dataDir, { recursive: true, force: true });
  expect(asked.length).toBe(1);
});

test("the terminal line has one rule: a command, or that the terminal is off", () => {
  expect(String(terminalLine({ reason: "no_listener" }))).toContain("The terminal is off.");
  expect(String(terminalLine({ reason: "no_tty" }))).toContain("The terminal is off.");
  expect(String(terminalLine({ command: "ssh -p 2222 x@localhost" }))).toContain("ssh -p 2222 x@localhost");
});

test("a closed sign-up in the terminal points at Start my forge", () => {
  expect(closedSignupText()).toContain("choose Start my forge");
});

test("the phone's top bar names its search width and keeps the buttons whole", () => {
  const css = String(componentsCss);
  expect(css).toContain("--topbar-search-basis");
  expect(css).not.toContain("flex: 0 1 96px");
  expect(css).toMatch(/\.topbar-tools \.btn \{[^}]*flex: none/);
});

let fresh: StartedForge;
test("the sent link's /claim takes the forge's own name too, with the code field visible", async () => {
  fresh = await startedForge("forge-claim-name-");
  try {
    const html = await (await fetch(`${fresh.base}/claim`)).text();
    expect(html).not.toMatch(/<div id="claim-token-field"[^>]*hidden/);
    const name = fresh.child.db.query<{ username: string }, []>("SELECT username FROM user WHERE kind = 'org' LIMIT 1").get()!.username;
    const res = await fetch(`${fresh.base}/claim`, {
      method: "POST",
      headers: { origin: fresh.base },
      body: new URLSearchParams({ token: fresh.token, username: name, email: "maria@bakery.test", password: "a-long-enough-password" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(fresh.child.db.query("SELECT kind FROM user WHERE username = ?").get(name)).toEqual({ kind: "user" });
  } finally {
    await fresh.stop();
  }
}, 60_000);
