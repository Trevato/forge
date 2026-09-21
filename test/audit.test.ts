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
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
    const a = await createUser(app.db, {
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
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a scaffolded app's standing is its table", async () => {
    const { getRepo } = await import("../src/core/repos.ts");
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
    expect(body).toContain("2 doors open to anyone");
    // The summary counts the apps with a contract and the doors they open.
    expect(body).toContain(
      "2 apps with a contract, 4 doors open to anyone, 1 contract unsound, 1 app unread.",
    );
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
});
