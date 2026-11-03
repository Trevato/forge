/** Trusted sources fold in by themselves (#8937): trust skips the person, nothing else. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { addTrust, removeTrust, setFoldInStopped } from "../src/actions/trusted_sources.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  dueWarning,
  foldsIn,
  isTrusted,
  listTrusted,
  pullSourceOf,
  recordPullSource,
  sourceOfUrl,
  sourceTrailers,
  takeable,
  trustSource,
  viaOf,
} from "../src/core/trusted_sources.ts";
import type { User } from "../src/core/users.ts";
import { landsOnItsOwn } from "../src/crew/direct.ts";
import { warnExpiring } from "../src/crew/fold_in.ts";
import { wallsTouched } from "../src/crew/fold_walls.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-trusted-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  const made = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  const first = await commitToBranch(app, alice, repo, { message: "First", files: [{ path: "README.md", content: "hi\n" }] });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  // The owner's list is theirs to fill: nothing is trusted until an owner action says so.
  expect(listTrusted(app.db)).toEqual([]);
  for (const who of ["tdobbertin-espo", "jmoran", "benjivers"])
    if (!addTrust(app, alice, { host: "git.open-platform.sh", account: who, until: "2099-12-02" }).ok) throw new Error(who);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const HOST = "git.open-platform.sh";

describe("the list", () => {
  test("nothing is trusted until an owner says so, then the name on that forge only", () => {
    const now = new Date("2026-11-03T00:00:00Z");
    for (const who of ["tdobbertin-espo", "jmoran", "benjivers"]) {
      expect(isTrusted(app.db, HOST, who, now)).toBe(true);
      expect(isTrusted(app.db, "evil.example", who, now)).toBe(false);
    }
    expect(listTrusted(app.db).every((s) => s.until.startsWith("2099-12-02"))).toBe(true);
  });

  test("expiry falls to review on its own, with a note 3 days before, once", () => {
    expect(isTrusted(app.db, HOST, "jmoran", new Date("2099-12-03T00:00:00Z"))).toBe(false);
    expect(dueWarning(app.db, new Date("2099-11-20T00:00:00Z"))).toEqual([]);
    expect(dueWarning(app.db, new Date("2099-11-30T00:00:00Z")).length).toBe(3);
    expect(warnExpiring(app, new Date("2099-11-30T00:00:00Z"))).toBe(3);
    expect(warnExpiring(app, new Date("2099-11-30T01:00:00Z"))).toBe(0);
    expect(app.db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'trust.expiring'").get()).toEqual({ n: 3 });
  });

  test("a change is audited, only an admin person may make it, and input is validated", () => {
    const bob = { ...alice, id: "x", isAdmin: false };
    expect(addTrust(app, bob, { host: HOST, account: "zed", until: "2027-01-01" }).ok).toBe(false);
    expect(addTrust(app, alice, { host: "no spaces", account: "zed", until: "2027-01-01" })).toEqual({ ok: false, error: "bad_host" });
    expect(addTrust(app, alice, { host: HOST, account: "../x", until: "2027-01-01" })).toEqual({ ok: false, error: "bad_account" });
    expect(addTrust(app, alice, { host: HOST, account: "zed", until: "soon" })).toEqual({ ok: false, error: "bad_date" });
    expect(addTrust(app, alice, { host: HOST, account: "zed", until: "2020-01-01" })).toEqual({ ok: false, error: "in_the_past" });
    const added = addTrust(app, alice, { host: `https://${HOST}/`, account: "@Zed", until: "2027-01-01" });
    if (!added.ok) throw new Error(added.error);
    expect(added.value).toMatchObject({ host: HOST, account: "zed", setBy: "alice" });
    const removed = removeTrust(app, alice, added.value.id);
    expect(removed.ok).toBe(true);
    expect(isTrusted(app.db, HOST, "zed")).toBe(false);
    const kinds = app.db.query<{ kind: string }, []>("SELECT kind FROM event WHERE kind LIKE 'trust.%'").all().map((e) => e.kind);
    expect(kinds).toContain("trust.set");
    expect(kinds).toContain("trust.removed");
  });
});

describe("what trust skips, and what it never does", () => {
  const push = async (branch: string, path: string) => {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: path,
      files: [{ path, content: "x\n" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    return done.value.commitOid;
  };
  const pullFrom = async (branch: string, account: string, host = HOST) => {
    await push(branch, `${branch}.md`);
    const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullSource(app.db, { pullId: opened.value.id, host, account, via: [] });
    return getPull(app.db, repo.id, opened.value.number)!;
  };

  test("a trusted source's pull lands without a person, a guest's does not", async () => {
    const trusted = await pullFrom("t/one", "jmoran");
    const guest = await pullFrom("t/two", "jmoran", "other.example");
    expect(foldsIn(app.db, trusted.id)).toBe(true);
    expect(landsOnItsOwn(app.db, repo, trusted)).toBe(true);
    expect(foldsIn(app.db, guest.id)).toBe(false);
    expect(pullMayRun(app.db, repo, trusted, trusted.headOid)).toBe(true);
  });

  test("the kill switch stops all folding in, and resuming restores it", async () => {
    const pull = await pullFrom("t/three", "benjivers");
    expect(foldsIn(app.db, pull.id)).toBe(true);
    expect(setFoldInStopped(app, alice, true).ok).toBe(true);
    expect(foldsIn(app.db, pull.id)).toBe(false);
    setFoldInStopped(app, alice, false);
    expect(foldsIn(app.db, pull.id)).toBe(true);
  });

  test("an expired source's pull waits for review", async () => {
    const pull = await pullFrom("t/four", "tdobbertin-espo");
    expect(foldsIn(app.db, pull.id, new Date("2100-01-01T00:00:00Z"))).toBe(false);
  });

  const walls: [string, string][] = [
    [".env", "secrets or credentials"],
    ["config/secrets.json", "secrets or credentials"],
    ["deploy/server.pem", "secrets or credentials"],
    ["src/core/sessions.ts", "secrets or credentials"],
    ["src/core/roles.ts", "permissions or the contract's walls"],
    ["src/contract/walls.ts", "permissions or the contract's walls"],
    ["src/core/pull_trust.ts", "permissions or the contract's walls"],
    ["src/crew/fold_walls.ts", "permissions or the contract's walls"],
    ["src/crew/autonomy.ts", "permissions or the contract's walls"],
    ["src/core/event_audience.ts", "permissions or the contract's walls"],
    ["src/actions/trusted_sources.ts", "permissions or the contract's walls"],
    ["src/http/passport_auth.ts", "permissions or the contract's walls"],
    ["src/core/migrations/20270101000000-x.ts", "release machinery"],
    ["src/core/migration-pins/20270101000000-x.pin", "release machinery"],
    ["scripts/cut-release.ts", "release machinery"],
    ["forge.json", "release machinery"],
    ["Dockerfile", "release machinery"],
  ];
  for (const [file, why] of walls)
    test(`a pull touching ${file} still waits for a person`, () => {
      expect(wallsTouched([file])).toEqual([`a trusted source's pull touches ${why}`]);
    });

  test("ordinary files are no wall", () => {
    expect(wallsTouched(["src/web/pages/home.ts", "README.md", "test/a.test.ts", "docs/a.md"])).toEqual([]);
  });

  test("a path nobody listed waits for a person: an allowlist, not a denylist", () => {
    expect(wallsTouched(["scripts/new-thing.ts"]).length).toBe(1);
    expect(wallsTouched(["AGENTS.md"]).length).toBe(1);
    expect(wallsTouched(["somewhere/else.txt"]).length).toBe(1);
  });

  test("a pull's source is stamped once: a later claim never rewrites it", async () => {
    const pull = await pullFrom("t/stamp", "jmoran");
    recordPullSource(app.db, { pullId: pull.id, host: "evil.example", account: "mallory", via: [] });
    expect(pullSourceOf(app.db, pull.id)).toMatchObject({ host: HOST, account: "jmoran" });
  });
});

describe("a ring of forges", () => {
  test("work that passed through a forge is not taken by it again", () => {
    const names = ["a.test", "b.test", "c.test"];
    // A lands work by someone on x.test; B follows A, C follows B, A follows C.
    let via: string[] = [];
    let origin = "x.test";
    const trail: string[] = [];
    for (let hop = 0; hop < 6; hop++) {
      const self = names[hop % 3]!;
      if (!takeable(via, self)) break;
      const trailers = sourceTrailers({ pullId: "p", host: origin, account: "jmoran", via }, self);
      via = viaOf(`Merge\n\n${trailers}`);
      origin = self;
      trail.push(self);
    }
    expect(trail).toEqual(["a.test", "b.test", "c.test"]);
    expect(via).toEqual(["x.test", "a.test", "b.test", "c.test"]);
  });

  test("a landing says where it came from", () => {
    const text = sourceTrailers({ pullId: "p", host: HOST, account: "jmoran", via: [] }, "forge.test");
    expect(text).toContain(`Landed-from: jmoran@${HOST}`);
    expect(viaOf(text)).toEqual([HOST, "forge.test"]);
  });

  test("an upstream's address names its forge and account", () => {
    expect(sourceOfUrl(`https://${HOST}/jmoran/app.git`)).toEqual({ host: HOST, account: "jmoran" });
    expect(sourceOfUrl("ssh://x/y")).toBeUndefined();
  });

  test("a pull's source is read back", () => {
    recordPullSource(app.db, { pullId: "zz", host: HOST, account: "jmoran", via: ["a.test"] });
    expect(pullSourceOf(app.db, "zz")?.via).toEqual(["a.test"]);
    expect(trustSource(app.db, { host: HOST, account: "q", until: "2020-01-01", setBy: "t" })).toBe("in_the_past");
  });
});

describe("the settings page", () => {
  test("lists the entries with a one-click remove and refuses a stranger", async () => {
    const { serve } = await import("../src/http/server.ts");
    const { createSession } = await import("../src/core/sessions.ts");
    const servers = await serve(app);
    try {
      const anon = await fetch(`${servers.url}/settings/trusted`, { redirect: "manual" });
      await anon.arrayBuffer();
      expect(anon.status).not.toBe(200);
      const res = await fetch(`${servers.url}/settings/trusted`, {
        headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("tdobbertin-espo");
      expect(text).toContain("/remove");
      expect(text).toContain("Stop all folding in");
    } finally {
      servers.stop();
    }
  });
});
