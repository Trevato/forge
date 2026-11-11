/**
 * The start door's guards (#10912): the claim page's account form follows the
 * forge's signup gate, a repository that will not move gives the link back, and
 * concurrent starts cannot overshoot the per-source cap.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimStart } from "../src/actions/claim.ts";
import { PER_SOURCE_PER_HOUR, startBuilding } from "../src/actions/start.ts";
import { createApp, type App } from "../src/app.ts";
import { startByClaim } from "../src/core/starts.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setSignup } from "../src/settings/signup.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let alice: User;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-start-claim-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.test", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  servers = await serve(app);
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(name: string, source: string) {
  const made = await startBuilding(app, { name }, source, servers.url);
  if (!made.ok) throw new Error(made.error.error);
  return { ...made.value, claimToken: made.value.claim.url.split("/").pop()! };
}

test("signup closed: the claim page offers no account form and the account form makes nothing", async () => {
  const s = await start("closed-door", "203.0.113.1");
  setSignup(app.db, "closed", alice.id);
  try {
    const page = await (await fetch(s.claim.url)).text();
    expect(page).not.toContain("/account");
    expect(page).toContain("/signin?next=");
    const posted = await fetch(`${s.claim.url}/account`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "intruder", email: "", password: "a-friendly-passphrase" }),
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("set-cookie") ?? "").not.toContain("forge_session");
    expect(getUserByName(app.db, "intruder")).toBeUndefined();
    expect(startByClaim(app.db, s.claimToken)!.claimedAt).toBeNull();
  } finally {
    setSignup(app.db, "open", alice.id);
  }
});

test("signup invite-only: the account form is closed too, without an invite", async () => {
  const s = await start("invite-door", "203.0.113.2");
  setSignup(app.db, "invite", alice.id);
  try {
    await fetch(`${s.claim.url}/account`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "intruder2", email: "", password: "a-friendly-passphrase" }),
    });
    expect(getUserByName(app.db, "intruder2")).toBeUndefined();
  } finally {
    setSignup(app.db, "open", alice.id);
  }
});

test("a repository that will not move gives the link back, and nothing is woken or renamed", async () => {
  const s = await start("stuck", "203.0.113.3");
  const person = await createUser(app.db, { origin: "seed", trusted: true, username: "friend", email: "f@f.test", password: "a-friendly-passphrase" });
  if (!person.ok) throw new Error(person.error);
  // Where the repository would land is already taken.
  mkdirSync(repoDir(app.reposRoot, `${s.user.username}-team`, "stuck"), { recursive: true });
  const refused = await claimStart(app, person.value, s.claimToken);
  expect(refused).toEqual({ ok: false, error: "failed" });
  expect(startByClaim(app.db, s.claimToken)!.claimedAt).toBeNull();
  // Once the place is free the same link works.
  rmSync(repoDir(app.reposRoot, `${s.user.username}-team`, "stuck"), { recursive: true });
  const taken = await claimStart(app, person.value, s.claimToken);
  expect(taken.ok).toBe(true);
  if (taken.ok) expect(taken.value.stayed).toEqual([]);
});

test("concurrent starts from one source take no more than the hourly cap", async () => {
  const results = await Promise.all(
    Array.from({ length: PER_SOURCE_PER_HOUR + 4 }, (_, i) => startBuilding(app, { name: `race-${i}` }, "203.0.113.9", servers.url)),
  );
  expect(results.filter((r) => r.ok).length).toBe(PER_SOURCE_PER_HOUR);
  const refused = results.filter((r) => !r.ok);
  expect(refused.every((r) => !r.ok && r.error.error === "rate_limited")).toBe(true);
  // A refused start leaves no account behind.
  expect(app.db.query("SELECT COUNT(*) AS n FROM user WHERE username LIKE 'race-%'").get()).toEqual({ n: PER_SOURCE_PER_HOUR });
});
