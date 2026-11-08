/**
 * The audit's first lens: who can do what, across every app, read from
 * each one's `contract.json` in git. A scaffolded app shows its table; a
 * contract that does not hold is called unsound, with every problem; an
 * app with no contract is listed as unread, never left out; and a viewer
 * sees exactly the apps they can read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp, newApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { audit, standingOf } from "../src/contract/audit.ts";
import {
  contractChanges,
  crossingsWaiting,
  verdictChanges,
} from "../src/contract/changes.ts";
import { recordProbe } from "../src/contract/probes.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** A forge of its own with alice signed in, for a test that changes what it reads. */
async function boot(prefix: string) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const signedIn = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({
      username: "alice",
      password: "a-good-passphrase",
    }),
    redirect: "manual",
  });
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).not.toBe("");
  const stop = async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, servers, alice: a.value, cookie, stop };
}

/** The four apps the audit's page reads: sound, unsound, unread, and a private one. */
async function seedApps(app: App, alice: User) {
  // A scaffolded app: born with a contract.
  const notes = await newApp(app, alice, {
    name: "notes",
    visibility: "public",
  });
  if (!notes.ok) throw new Error(String(notes.error));

  // An app whose contract does not hold.
  const broken = await createRepo(app, alice, {
    name: "broken",
    visibility: "public",
  });
  if (!broken.ok) throw new Error(String(broken.error));
  const wrote = await commitToBranch(app, alice, broken.value, {
    message: "a contract that names a ghost",
    files: [
      {
        path: "contract.json",
        content: JSON.stringify({
          roles: { anon: { above: [], held: { by: "everyone" } } },
          resources: {
            thing: {
              can: {
                create: "ghost",
                read: "anon",
                update: "anon",
                delete: "anon",
                list: "anon",
              },
            },
          },
        }),
      },
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  expect(enableApp(app, alice, broken.value).ok).toBe(true);

  // An app with no contract at all.
  const bare = await createRepo(app, alice, {
    name: "bare",
    visibility: "public",
  });
  if (!bare.ok) throw new Error(String(bare.error));
  const seeded = await commitToBranch(app, alice, bare.value, {
    message: "no contract",
    files: [{ path: "README.md", content: "# bare\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(enableApp(app, alice, bare.value).ok).toBe(true);

  // A private app: its policy is for its readers.
  const secret = await newApp(app, alice, {
    name: "secret",
    visibility: "private",
  });
  if (!secret.ok) throw new Error(String(secret.error));
}

describe("the audit reads every app's policy from git", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-audit-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const signedIn = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).not.toBe("");

    await seedApps(app, alice);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a scaffolded app's standing is its table", async () => {
    const { app, alice, stop } = await boot("forge-audit-standing-");
    try {
      const made = await newApp(app, alice, { name: "notes", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = getRepo(app.db, "alice", "notes")!;
      const a = await audit(app.reposRoot, repo);
      expect(a.oid).toMatch(/^[0-9a-f]{40}$/);
      expect(a.standing.kind).toBe("sound");
      if (a.standing.kind !== "sound") return;
      expect(a.standing.identities).toEqual(["anon", "user", "admin"]);
      expect(a.standing.open.map((c) => `${c.resource}.${c.verb}`)).toEqual([
        "note.read",
        "note.list",
      ]);
    } finally {
      await stop();
    }
  });

  test("what cannot be read is said, not skipped", () => {
    expect(standingOf(undefined)).toEqual({ kind: "unread" });
    const huge = standingOf("x".repeat(300 * 1024));
    expect(huge.kind).toBe("unsound");
    const bad = standingOf("{");
    expect(bad).toEqual({
      kind: "unsound",
      problems: ["contract.json is not JSON"],
    });
  });

  test("the page: every app the viewer can read, each in its standing", async () => {
    const { app, servers, alice, cookie, stop } = await boot("forge-audit-page-");
    try {
      await seedApps(app, alice);
      const res = await fetch(`${servers.url}/audit`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("alice/notes");
      expect(body).toContain("alice/broken");
      expect(body).toContain("alice/bare");
      expect(body).toContain("alice/secret");
      expect(body).toContain("contract unsound");
      expect(body).toContain("needs `ghost`, which is not declared");
      expect(body).toContain("Unread");
      // The table's cells, as the scaffold's contract says.
      expect(body).toMatch(/data-answer="own"/);
      // …each answer a §5 badge, in a §5 table, under the app's heading.
      expect(body).toMatch(
        /<td data-answer="own">\s*<span\s+class="badge"\s+data-variant="secondary"\s*>own<\/span/,
      );
      expect(body).toContain('<table class="table" data-dense>');
      expect(body).toMatch(
        /<div class="card-head"><h3><a href="\/alice\/notes">alice\/notes<\/a><\/h3>/,
      );
      // Rows, not boxes (#9710): each app's standing is a heading over its
      // rows on the page's one background — a bare card, no frame, no tone,
      // no icon before the name — and nothing on the page is a boxed card.
      for (const app of ["alice-notes", "alice-broken", "alice-secret"])
        expect(body).toMatch(
          new RegExp(`<div\\s+class="card bare"\\s+id="${app}"\\s*>`),
        );
      const main = body.slice(body.indexOf("<h1>Audit</h1>"));
      expect(main).not.toMatch(/class="card"/);
      expect(main).not.toMatch(/class="card[^"]*"[^>]*data-tone=/);
      expect(main).toMatch(
        /<div class="card-head"><h3>Unread<\/h3><\/div>\s*<ul class="list">/,
      );
      // The unread apps are §5 rows.
      expect(body).toMatch(/<a href="\/alice\/bare"\s+class="row"/);
      expect(body).not.toMatch(/class="[^"]*\baudit\b/);
      expect(body).not.toContain("audit-");
      expect(body).toContain("2 doors open to anyone");
      // The summary counts the apps with a contract and the doors they open.
      expect(body).toContain(
        "2 apps with a contract, 4 doors open to anyone, 1 contract unsound, 1 app unread.",
      );
    } finally {
      await stop();
    }
  });

  test("a stranger sees the public apps' policies and nothing of the private", async () => {
    const res = await fetch(`${servers.url}/audit`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("alice/notes");
    expect(body).toContain("alice/bare");
    expect(body).not.toContain("secret");
  });

  test("a forge with no apps says so", async () => {
    const empty = await mkdtemp(join(tmpdir(), "forge-audit-empty-"));
    const lone = createApp({ dataDir: empty, port: 0 });
    const s = await serve(lone);
    try {
      const body = await (await fetch(`${s.url}/audit`)).text();
      expect(body).toContain("No apps to audit");
    } finally {
      s.stop();
      lone.close();
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("what changed: contract commits, a crossing waiting, a verdict that flipped", async () => {
    // Its own forge: this test rewrites notes' contract, which the shared
    // forge's other tests read as the scaffold's.
    const { app, servers, alice, cookie, stop } = await boot(
      "forge-audit-changes-",
    );
    try {
      const made = await newApp(app, alice, {
        name: "notes",
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      const notes = getRepo(app.db, "alice", "notes")!;
      const record = getAppByRepo(app.db, notes.id)!;
      // A commit that opens a door, then one that closes two.
      const text = (
        (await (
          await fetch(
            `${servers.url}/api/v1/repos/alice/notes/contents/contract.json`,
          )
        ).json()) as { content: string }
      ).content;
      const contract = JSON.parse(text) as {
        resources: { note: { can: Record<string, string> } };
      };
      const wider = structuredClone(contract);
      wider.resources.note.can.create = "anon";
      const opened = await commitToBranch(app, alice, notes, {
        message: "anyone may add",
        files: [{ path: "contract.json", content: JSON.stringify(wider) }],
      });
      expect(opened.ok).toBe(true);
      const narrower = structuredClone(wider);
      narrower.resources.note.can.read = "user";
      narrower.resources.note.can.list = "user";
      const closed = await commitToBranch(app, alice, notes, {
        message: "only the signed-in read",
        files: [{ path: "contract.json", content: JSON.stringify(narrower) }],
      });
      expect(closed.ok).toBe(true);
      const changes = await contractChanges(app.reposRoot, notes);
      expect(changes.map((c) => c.subject)).toEqual([
        "only the signed-in read",
        "anyone may add",
        expect.any(String),
      ]);
      expect(changes[0]!.loosened).toEqual([]);
      expect(
        changes[0]!.tightened.map((t) => `${t.verb}.${t.as}`).sort(),
      ).toEqual(["list.anon", "read.anon"]);
      expect(changes[1]!.loosened.map((l) => `${l.verb}.${l.as}`)).toEqual([
        "create.anon",
      ]);
      // The first commit, the scaffold's: the floor's open cells are what was decided.
      expect(
        changes[2]!.loosened.map((l) => `${l.verb}.${l.as}`).sort(),
      ).toEqual(["list.anon", "read.anon"]);

      // A pull at the wall, as the crew would leave it.
      const branch = await commitToBranch(app, alice, notes, {
        branch: "wider-still",
        message: "anyone may delete",
        files: [
          {
            path: "contract.json",
            content: JSON.stringify({
              ...narrower,
              resources: {
                note: {
                  can: { ...narrower.resources.note.can, delete: "anon" },
                },
              },
            }),
          },
        ],
      });
      expect(branch.ok).toBe(true);
      const pull = await openPull(app, alice, notes, {
        title: "Anyone may delete",
        baseBranch: "main",
        headBranch: "wider-still",
      });
      if (!pull.ok) throw new Error(JSON.stringify(pull.error));
      recordDecision(app.db, {
        kind: "land",
        repoId: notes.id,
        issueId: pull.value.id,
        state: {
          head: pull.value.headOid,
          cells: ["note.delete as anon: was no, now yes"],
          plain: ["anyone signed out could delete note records"],
        },
        answer: "wall",
        p: 1,
        by: "wall",
        ms: 0,
      });
      const waiting = crossingsWaiting(app.db, [notes]);
      expect(waiting.map((c) => c.pull.title)).toEqual(["Anyone may delete"]);
      expect(waiting[0]!.cells).toEqual([
        "note.delete as anon: was no, now yes",
      ]);
      expect(waiting[0]!.plain).toEqual([
        "anyone signed out could delete note records",
      ]);

      // Two probes, the second disagreeing with the first.
      recordProbe(app.db, record.id, {
        repo: notes,
        commitOid: "a".repeat(40),
        at: "",
        verdict: "ok",
        knocks: [],
        said: [],
      });
      recordProbe(app.db, record.id, {
        repo: notes,
        commitOid: "b".repeat(40),
        at: "",
        verdict: "mismatch",
        knocks: [],
        said: ["note.delete as anon: the table says no, the app said 404"],
      });
      const flips = verdictChanges(app.db, [{ repo: notes, appId: record.id }]);
      expect(flips.map((f) => [f.from, f.to])).toEqual([
        ["ok", "mismatch"],
        [undefined, "ok"],
      ]);

      const body = await (
        await fetch(`${servers.url}/audit`, { headers: { cookie } })
      ).text();
      expect(body).toContain("What changed");
      expect(body).toContain("1 pull waits");
      expect(body).toContain("Anyone may delete");
      expect(body).toContain("anyone signed out could delete note records");
      expect(body).toContain("only the signed-in read");
      expect(body).toContain("2 doors narrower");
      expect(body).toContain("1 door wider");
      expect(body).toContain("Doors, over time");
      expect(body).toContain("alice/notes disobeys its table");
      // A stranger sees the public app's history too; the ledger row is about
      // a public pull, so the crossing is as public as the pull.
      const anon = await (await fetch(`${servers.url}/audit`)).text();
      expect(anon).toContain("only the signed-in read");
    } finally {
      await stop();
    }
  }, 30_000);

  test("the table file: one row per cell, with what the door said", async () => {
    const res = await fetch(`${servers.url}/audit.csv`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).split("\r\n").filter((l) => l !== "");
    expect(lines[0]).toBe(
      "app,commit,standing,resource,verb,identity,answer,door",
    );
    // The scaffold's table, as the private app still has it.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^alice\/secret,[0-9a-f]{7},sound,note,create,anon,no,$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^alice\/secret,[0-9a-f]{7},sound,note,delete,user,own,$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^alice\/broken,[0-9a-f]{7},unsound,,,,,$/),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^alice\/bare,[0-9a-f]{7},unread,,,,,$/),
    );
    // A stranger's file has no private app in it.
    const anon = await (await fetch(`${servers.url}/audit.csv`)).text();
    expect(anon).not.toContain("secret");
    expect(anon).toContain("alice/notes");
  });

  test("the way in: the studio home links the audit, and an app's page says its policy in one line", async () => {
    const home = await (
      await fetch(`${servers.url}/feed`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(home).toContain('href="/audit"');
    const notes = await (
      await fetch(`${servers.url}/alice/notes`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(notes).not.toContain("policy-line");
    expect(notes).toContain('class="badge"');
    expect(notes).toContain("2 resources");
    expect(notes).toContain('href="/audit#alice-notes"');
    // The audit page carries that anchor.
    const page = await (
      await fetch(`${servers.url}/audit`, { headers: { cookie } })
    ).text();
    expect(page).toContain('id="alice-notes"');
    // An app with no contract says nothing about a policy it does not have.
    const bare = await (
      await fetch(`${servers.url}/alice/bare`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(bare).not.toContain("policy-line");
    expect(bare).not.toContain("The table");
  });

  test("an app's policy line badges the last verdict: success when it obeys, danger when it does not", async () => {
    const notes = getRepo(app.db, "alice", "notes")!;
    const record = getAppByRepo(app.db, notes.id)!;
    const page = async () =>
      (
        await fetch(`${servers.url}/alice/notes`, {
          headers: { cookie: `${cookie}; forge_mode=studio` },
        })
      ).text();
    const probe = (verdict: "ok" | "mismatch", said: string[]) =>
      recordProbe(app.db, record.id, {
        repo: notes,
        commitOid: "c".repeat(40),
        at: "",
        verdict,
        knocks: [],
        said,
      });
    probe("ok", []);
    const ok = await page();
    expect(ok).toContain('data-variant="success"');
    expect(ok).toContain("obeys its table");
    expect(ok).toContain("setting-list");
    expect(ok).toMatch(/data-variant="success"\s*>\s*(<svg[\s\S]*?<\/svg>)?obeys</);
    expect(ok).not.toContain("policy-line");
    probe("mismatch", ["note.delete as anon: the table says no, the app said 404"]);
    const bad = await page();
    expect(bad).toContain('data-variant="danger"');
    expect(bad).toContain("one door disobeys its table");
    expect(bad).toMatch(/data-variant="danger"\s*>\s*(<svg[\s\S]*?<\/svg>)?disobeys</);
    expect(bad).not.toContain("policy-line");
  });
});
