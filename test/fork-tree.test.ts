import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { forkTree, getRepo } from "../src/core/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { forksScreen } from "../src/tui/screens/forks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("the forks page draws the tree", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  const users: Record<string, User> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-tree-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob", "carol", "dan", "erin", "fay"]) {
      users[name] = must(
        await createUser(app.db, {
          origin: "seed",
          trusted: true,
          username: name,
          email: `${name}@f.dev`,
          password: "a-good-passphrase",
          adminIfFirst: name === "alice",
        }),
      );
      promote(app.db, users[name]!);
    }
    const upstream = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
    const bob = must(await forkRepo(app, users["bob"]!, upstream));
    must(await forkRepo(app, users["carol"]!, upstream));
    const dan = must(await forkRepo(app, users["dan"]!, bob));
    must(await forkRepo(app, users["erin"]!, dan));
    must(await forkRepo(app, users["fay"]!, dan, "secret", { visibility: "private" }));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fork of a fork is nested under its parent; deeper forks are a count", async () => {
    const text = await (await fetch(`${servers.url}/alice/app/forks`, { headers: { cookie: "forge_mode=dev" } })).text();
    const at = (s: string) => text.indexOf(s);
    for (const who of ["bob", "carol", "dan"]) expect(at(`href="/${who}/app"`)).toBeGreaterThan(-1);
    const ul = at('<ul class="row-children">');
    expect(ul).toBeGreaterThan(-1);
    expect(at('href="/dan/app"')).toBeGreaterThan(ul);
    expect(text).toContain('href="/dan/app/forks"');
    expect(text).toContain("and 1 more fork below");
  });

  test("a private fork is never named or counted to someone who cannot read it", async () => {
    const text = await (await fetch(`${servers.url}/alice/app/forks`, { headers: { cookie: "forge_mode=dev" } })).text();
    expect(text).not.toContain("fay/secret");
    expect(text).not.toContain("and 2 more");
    const alice = getRepo(app.db, "alice", "app")!;
    const dan = forkTree(app.db, alice.id, undefined).find((n) => n.repo.ownerName === "bob")!.forks[0]!;
    expect(dan.deeper).toBe(1);
    const seenByFay = forkTree(app.db, alice.id, users["fay"]!).find((n) => n.repo.ownerName === "bob")!.forks[0]!;
    expect(seenByFay.deeper).toBe(2);
  });

  test("the terminal's forks screen indents the second level and counts what is below", async () => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "carol", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: users["carol"]! },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, "alice", "app")!));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toMatch(/\n\S* ?bob\/app/);
    expect(text).toMatch(/\n {4}dan\/app/);
    expect(text).toContain("and 1 more fork below");
    expect(text).not.toContain("fay/secret");
  });
});
