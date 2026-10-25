import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import {
  MAX_RANKED_FORKS,
  rankedForksOf,
  rankForks,
  type RankedFork,
} from "../src/actions/forks.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo, listForks } from "../src/core/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { forksScreen } from "../src/tui/screens/forks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("rankForks", () => {
  const f = (id: string, ahead: number | null, behind: number | null, pushedAt: string | null) =>
    ({ fork: { id } as Repo, drift: { ahead, behind }, pushedAt }) as RankedFork;
  test("ahead desc, then behind asc, then newest push; level forks apart", () => {
    const { offering, nothingNew } = rankForks([
      f("d", 0, 0, "2026-01-05T00:00:00Z"),
      f("b", 2, 3, "2026-01-01T00:00:00Z"),
      f("c", 2, 1, "2026-01-01T00:00:00Z"),
      f("a", 3, 9, "2026-01-01T00:00:00Z"),
      f("e", 2, 1, "2026-02-01T00:00:00Z"),
      f("n", null, null, null),
    ]);
    expect(offering.map((x) => x.fork.id)).toEqual(["a", "e", "c", "b"]);
    expect(nothingNew.map((x) => x.fork.id)).toEqual(["d", "n"]);
  });
});

describe("the forks page ranks", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let upstream: Repo;
  const users: Record<string, User> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-rank-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob", "carol", "dan", "erin"]) {
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
    upstream = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
    const commit = async (who: string, repo: Repo, n: number) => {
      for (let i = 0; i < n; i++)
        must(
          await commitToBranch(app, users[who]!, repo, {
            message: `${who} ${i} ${repo.name}`,
            files: [{ path: `${who}-${repo.name}-${i}.txt`, content: "x\n" }],
          }),
        );
    };
    await commit("alice", upstream, 1);
    const bob = must(await forkRepo(app, users["bob"]!, upstream));
    const carol = must(await forkRepo(app, users["carol"]!, upstream));
    const dan = must(await forkRepo(app, users["dan"]!, upstream));
    must(await forkRepo(app, users["erin"]!, upstream));
    await commit("bob", bob, 1);
    await commit("carol", carol, 2);
    await commit("dan", dan, 3);
    await commit("alice", upstream, 1); // everyone now 1 behind
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("most ahead first, links to compare, level forks last under their count", async () => {
    const res = await fetch(`${servers.url}/alice/app/forks`, {
      headers: { cookie: "forge_mode=dev" },
    });
    const text = await res.text();
    const at = (s: string) => text.indexOf(s);
    expect(text).toContain("3 ahead · 1 behind");
    expect(text).toContain("2 ahead · 1 behind");
    expect(text).toContain("1 ahead · 1 behind");
    expect(text).toContain("0 ahead · 0 behind");
    expect(text).toContain("1 fork with nothing new");
    expect(at("/carol/app")).toBeGreaterThan(-1);
    // dan is furthest ahead; carol next; bob last of those with work.
    expect(at('href="/dan/app"')).toBeLessThan(at('href="/carol/app"'));
    expect(at('href="/carol/app"')).toBeLessThan(at('href="/bob/app"'));
    expect(at('href="/bob/app"')).toBeLessThan(at("1 fork with nothing new"));
    expect(at("1 fork with nothing new")).toBeLessThan(at('href="/erin/app"'));
    expect(text).toContain('href="/bob/app/pulls/new"');
    expect(text).not.toContain('href="/erin/app/pulls/new"');
  });

  test("Compare opens the fork's own proposal page, aimed at the parent and not at the fork", async () => {
    const cookie = `forge_session=${createSession(app.db, users["carol"]!.id).token}; forge_mode=dev`;
    const res = await fetch(`${servers.url}/carol/app/pulls/new`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('name="baseRepo" value="parent"');
    expect(text).toContain("alice/app");
    expect(text).toContain("Proposing");
  });

  test("past the bound the ranking says so, and the count stays whole", async () => {
    const bob = getRepo(app.db, "bob", "app")!;
    const forks = Array.from({ length: MAX_RANKED_FORKS + 1 }, () => bob);
    const ranked = await rankedForksOf(app, upstream, forks);
    expect(ranked.total).toBe(MAX_RANKED_FORKS + 1);
    expect(ranked.truncated).toBe(true);
    expect(ranked.offering.length).toBe(MAX_RANKED_FORKS);
    const again = await rankedForksOf(app, upstream, forks);
    expect(again.offering.map((f) => f.drift)).toEqual(ranked.offering.map((f) => f.drift));
  });

  test("the terminal's forks screen shows the same order and words", async () => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: users["alice"]! },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, "alice", "app")!));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(listForks(app.db, upstream.id).length).toBe(4);
    const at = (s: string) => text.indexOf(s);
    expect(at("dan/app")).toBeGreaterThan(-1);
    expect(at("dan/app")).toBeLessThan(at("carol/app"));
    expect(at("carol/app")).toBeLessThan(at("bob/app"));
    expect(at("bob/app")).toBeLessThan(at("erin/app"));
    expect(text).toContain("3 ahead · 1 behind");
    expect(text).toContain("1 fork with nothing new");
  });

  test("enter on a fork opens that fork's workspace", async () => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: users["alice"]! },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, "alice", "app")!));
    await settleApp(tui);
    terminal.feed("\r");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("dan/app");
    expect(text).not.toContain("nothing new");
  });
});
