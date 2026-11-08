// The Held files card on /boards (#7057): every repository admin sees it, with
// the hold form, and only the holds of repositories they administer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { holdFileAs } from "../src/actions/file_holds.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { MAX_HOLD_PATH } from "../src/crew/file_holds.ts";
import { fileHoldLine } from "../src/tui/screens/fileholds.ts";
import type { Session } from "../src/tui/session.ts";
import { quiet } from "./helpers/statements.ts";

describe("the Held files card on /boards", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let carol: User;
  let alice: User;
  let dave: User;
  const cookies: Record<string, string> = {};

  const person = async (username: string, first = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const signIn = async (username: string): Promise<string> =>
    ((await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const boards = (who: string) => fetch(`${servers.url}/boards`, { headers: { cookie: cookies[who]! } });
  const post = (who: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/boards/holds`, {
      method: "POST",
      headers: { cookie: cookies[who]!, origin },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "boards-holds-"));
    app = createApp({ dataDir: dir, port: 0 });
    alice = await person("alice", true);
    carol = await person("carol");
    const bob = await person("bob");
    dave = await person("dave");
    for (const u of ["carol", "bob", "dave"]) setRole(app, alice, u, "member");
    servers = await serve(app);
    for (const u of ["alice", "carol", "bob", "dave"]) cookies[u] = await signIn(u);
    for (const [u, name, visibility] of [
      [carol, "cs", "public"],
      [bob, "bobs", "public"],
      [bob, "hidden", "private"],
      [dave, "ds", "public"],
    ] as const) {
      const made = await createRepo(app, u, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("carol, who administers only her repository, holds a path there and sees it, not bob's", async () => {
    const empty = await (await boards("carol")).text();
    expect(empty).toContain('id="board-holds"');
    expect(empty).toContain("No file is held.");
    expect(empty).toContain('action="/boards/holds"');

    const held = await post("carol", { repo: "carol/cs", path: "src/a.ts", verb: "hold" });
    expect(held.status).toBe(303);
    expect(held.headers.get("location")).toStartWith("/boards");
    await post("bob", { repo: "bob/bobs", path: "src/secret-plan.ts", verb: "hold" });
    await post("bob", { repo: "bob/hidden", path: "src/private.ts", verb: "hold" });

    const page = await (await boards("carol")).text();
    expect(page).toContain("src/a.ts");
    expect(page).toContain("carol/cs");
    expect(page).not.toContain("src/secret-plan.ts");
    expect(page).not.toContain('data-repo="bob/bobs"');
    expect(page).not.toContain("src/private.ts");
  });

  test("she can neither hold nor release in a repository she does not administer", async () => {
    await post("carol", { repo: "bob/bobs", path: "src/x.ts", verb: "hold" });
    await post("carol", { repo: "bob/bobs", path: "src/secret-plan.ts", verb: "release" });
    const bobs = await (await boards("bob")).text();
    expect(bobs).not.toContain("src/x.ts");
    expect(bobs).toContain("src/secret-plan.ts");
  });

  test("a private repository's hold is shown to its admin and not to a non-reader", async () => {
    expect(await (await boards("bob")).text()).toContain("src/private.ts");
    expect(await (await boards("carol")).text()).not.toContain("src/private.ts");
  });

  test("a forge admin sees every hold, under the flow panel", async () => {
    const page = await (await boards("alice")).text();
    for (const p of ["src/a.ts", "src/secret-plan.ts", "src/private.ts"]) expect(page).toContain(p);
    expect(page.indexOf('id="board-holds"')).toBeGreaterThan(page.indexOf('id="queue"'));
  });

  test("a person with a repository of their own sees the card; a stranger gets no page", async () => {
    expect((await boards("dave")).status).toBe(200);
    await person("erin");
    setRole(app, alice, "erin", "member");
    cookies.erin = await signIn("erin");
    expect((await boards("erin")).status).toBe(404);
    expect((await fetch(`${servers.url}/boards`, { redirect: "manual" })).status).not.toBe(200);
  });

  test("a cross-origin post is refused and holds nothing", async () => {
    const res = await post("carol", { repo: "carol/cs", path: "src/evil.ts", verb: "hold" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await (await boards("carol")).text()).not.toContain("src/evil.ts");
  });

  test("a held path is escaped", async () => {
    const made = await createRepo(app, carol, { name: "x", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    holdFileAs(app, carol, made.value, "a/<img src=x>.ts");
    const page = await (await boards("carol")).text();
    expect(page).not.toContain("<img src=x>");
    expect(page).toContain("&lt;img src=x&gt;");
  });

  test("the menu links Boards to a repository admin, not to a stranger", async () => {
    const link = 'href="/boards"';
    expect(await (await fetch(`${servers.url}/`, { headers: { cookie: cookies.carol! } })).text()).toContain(link);
    expect(await (await fetch(`${servers.url}/`, { headers: { cookie: cookies.erin! } })).text()).not.toContain(link);
  });

  test("Hold file is secondary under the board list and primary on the card-only page", async () => {
    const hold = /<button[^>]*data-variant="(\w+)"[^>]*>\s*Hold file/;
    expect((await (await boards("alice")).text()).match(hold)?.[1]).toBe("secondary");
    expect((await (await boards("carol")).text()).match(hold)?.[1]).toBe("primary");
  });

  test("the fields carry their limits", async () => {
    const page = await (await boards("carol")).text();
    expect(page).toContain(`maxlength="${MAX_HOLD_PATH}"`);
    expect(page).toContain('maxlength="80"');
  });

  test("a bare line in the terminal lists every hold the viewer administers", () => {
    const f = { db: app.db, app, user: carol } as unknown as Session;
    const got = fileHoldLine(f, "");
    expect(got.ok).toBe(true);
    expect(got.says).toContain("carol/cs src/a.ts");
    expect(got.says).not.toContain("secret-plan");
  });

  test("a cut list says how many there are", async () => {
    const made = await createRepo(app, dave, { name: "many", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    for (let i = 0; i < 205; i++) holdFileAs(app, dave, made.value, `m/${i}.ts`);
    const page = await (await boards("dave")).text();
    expect(page).toContain("Showing 200 of 205 holds");
  });

  test("a second load adds one card query however many holds there are", async () => {
    const count = async (): Promise<{ all: number; hold: number }> => {
      await quiet(app.db);
      const db = app.db as unknown as { query: (sql: string) => unknown };
      const real = db.query;
      const n = { all: 0, hold: 0 };
      db.query = function (this: unknown, sql: string) {
        n.all++;
        if (sql.includes("file_hold")) n.hold++;
        return real.call(this, sql);
      };
      try {
        await (await boards("alice")).text();
      } finally {
        db.query = real;
      }
      return n;
    };
    const least = async () => {
      const runs = [await count(), await count(), await count()];
      return { all: Math.min(...runs.map((r) => r.all)), hold: Math.min(...runs.map((r) => r.hold)) };
    };
    const before = await least();
    const made = await createRepo(app, carol, { name: "y", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    for (let i = 0; i < 15; i++) holdFileAs(app, carol, made.value, `f${i}.ts`);
    const after = await least();
    expect(after.all).toBe(before.all);
    expect(after.hold).toBe(1);
  });
});
