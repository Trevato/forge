/** `pack up`'s path against a fake source: Games and Business arrive with history, followed, with their crew, and nothing is carried but code. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { crewHasCredential } from "../src/core/subscriptions.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getRepo } from "../src/core/repos.ts";
import { getFollow } from "../src/core/upstream_follow.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { fixturePacks } from "./helpers/packs.ts";
import { deployPack } from "../src/packs/deploy.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { checkUpstream } from "../src/actions/upstream_follow.ts";
import { getRepoById } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { mirrorOutboundForTest, provideMirrorOutboundForTest } from "../src/origins/git-mirror.ts";
import { finishWords, OWNER, prepareOwner } from "../src/packs/up.ts";
import { deployCommands } from "../src/packs/words.ts";
import { repoDir } from "../src/git/repos.ts";
import { realHands, up } from "../scripts/pack.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let root: string;
let dataDir: string;
let app: App;
let servers: Servers;
let token: string;
let passphrase: string | undefined;
const fake = new Map<string, string>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "packs-up-"));
  dataDir = join(root, "data");
  const prepared = await prepareOwner(dataDir);
  token = prepared.token;
  passphrase = prepared.passphrase;
  // A fake source for every app of both packs: three commits and a tag, on a branch that is not "main" for one of them.
  let n = 0;
  for (const pack of fixturePacks())
    for (const a of pack.apps) {
      const dir = join(root, `src-${n++}`);
      git(root, "init", "-q", "-b", n === 1 ? "master" : "main", dir);
      for (const i of [1, 2, 3]) {
        await Bun.write(join(dir, "f.txt"), `${a.name} ${i}\n`);
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", `commit ${i}`);
      }
      git(dir, "tag", "v1");
      fake.set(a.source, dir);
    }
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(root, { recursive: true, force: true });
});

describe("the one command, against a fake source", () => {
  test("the command is one line to run after clone and install, and asks for no token", () => {
    for (const p of fixturePacks()) {
      const lines = deployCommands(p, "https://f.example");
      expect(lines.some((l) => l.startsWith(`bun scripts/pack.ts up ${p.name}`))).toBe(true);
      expect(lines[0]).toContain("bun install");
    }
  });

  test("the owner is made once, its passphrase kept private, and a second run reuses it", async () => {
    expect(passphrase?.length).toBeGreaterThan(15);
    const file = join(dataDir, "owner-passphrase");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const before = await readFile(file, "utf8");
    expect(before.trim()).toBe(passphrase!);
    const again = await prepareOwner(dataDir, {});
    expect(again.passphrase).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(app.db.query("SELECT COUNT(*) AS n FROM user WHERE username = ?1").get(OWNER)).toEqual({ n: 1 });
    // The same account: the token the second run mints is the owner's.
    const who = await fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${again.token}` } });
    expect(((await who.json()) as { username: string }).username).toBe(OWNER);
  });

  for (const name of ["games", "business"]) {
    test(`${name}: every app arrives with history, followed; the crew is configured; no secret or variable travels`, async () => {
      const pack = fixturePacks().find((p) => p.name === name)!;
      const steps = await deployPack(pack, realHands(servers.url, token, { cloneFrom: (s) => fake.get(s)! }));
      expect(steps.filter((s) => s.state !== "done")).toEqual([]);
      for (const a of pack.apps) {
        const repo = getRepo(app.db, OWNER, a.name)!;
        expect(repo).toBeDefined();
        const dir = repoDir(app.reposRoot, OWNER, a.name);
        const src = fake.get(a.source)!;
        const head = git(src, "symbolic-ref", "--short", "HEAD");
        expect(git(dir, "rev-parse", `refs/heads/${head}`)).toBe(git(src, "rev-parse", "HEAD"));
        expect(git(dir, "rev-list", "--count", `refs/heads/${head}`)).toBe("3");
        expect(git(dir, "rev-parse", "refs/tags/v1")).toBe(git(src, "rev-parse", "v1"));
        const follow = getFollow(app.db, repo.id)!;
        expect(follow.enabled).toBe(true);
        expect(follow.url).toBe(a.source);
        expect(follow.branch).toBe(git(src, "symbolic-ref", "--short", "HEAD"));
        expect((await fetch(`${servers.url}/${OWNER}/${a.name}`)).status).toBe(200);
      }
      for (const c of pack.crew) {
        const agent = getAgentByName(app.db, c.username)!;
        expect(c.roles.length).toBeGreaterThan(0);
        expect([...agent.roles].sort()).toEqual([...c.roles].sort());
      }
    });
  }

  test("running it again keeps what exists", async () => {
    const pack = fixturePacks()[0]!;
    const steps = await deployPack(pack, realHands(servers.url, token, { cloneFrom: (s) => fake.get(s)! }));
    expect(steps.map((s) => `${s.what} ${s.state} ${s.note}`)).toEqual(steps.map((s) => `${s.what} kept already here`));
  });

  test("a credential stored in the forge counts even when the environment has none", async () => {
    const d = await mkdtemp(join(tmpdir(), "packs-cred-"));
    try {
      expect((await prepareOwner(d, {})).credential).toBe(false);
      const a2 = createApp({ dataDir: d, port: 0 });
      const added = addSubscription(a2.db, d, { name: "mine", token: "sk-ant-oat01-" + "x".repeat(40) });
      a2.close();
      expect(added.ok).toBe(true);
      const again = await prepareOwner(d, {});
      expect(again.credential).toBe(true);
      expect(finishWords("http://localhost:3000", again.credential).join("\n")).not.toContain("crew is off");
      expect((await prepareOwner(await mkdtemp(join(tmpdir(), "packs-cred2-")), { ANTHROPIC_API_KEY: "k" })).credential).toBe(true);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("with no model credential the forge says the crew is off, and says where to add one", () => {
    expect(crewHasCredential(app.db, {})).toBe(false);
    expect(finishWords("http://localhost:3000", false).join("\n")).toContain("crew is off until you add a model credential");
    expect(finishWords("http://localhost:3000", true).join("\n")).not.toContain("crew is off");
  });

  test("a partial deploy is finished by running it again: a kept app that was never followed is followed", async () => {
    const pack = fixturePacks()[0]!;
    const hands = realHands(servers.url, token, { cloneFrom: (s) => fake.get(s)! });
    // First run: the follow of the first app fails after the app and its history are in.
    const one = { ...pack, apps: [{ ...pack.apps[0]!, name: "partial-app" }], crew: [] };
    let fail = true;
    const steps1 = await deployPack(one, { ...hands, follow: (...a) => (fail ? Promise.resolve({ ok: false, why: "down" }) : hands.follow(...a)) });
    expect(steps1[0]!.state).toBe("failed");
    const repo = getRepo(app.db, OWNER, "partial-app")!;
    expect(getFollow(app.db, repo.id)).toBeUndefined();
    fail = false;
    const steps2 = await deployPack(one, { ...hands, follow: (...a) => hands.follow(...a) });
    expect(steps2[0]!.state).toBe("kept");
    const f = getFollow(app.db, repo.id)!;
    expect(f.enabled).toBe(true);
    expect(f.url).toBe(one.apps[0]!.source);
    expect(f.branch).toBe(repo.defaultBranch);
  });

  test("no branch to follow fails the step, and never follows main by guess", async () => {
    const hands = realHands(servers.url, token);
    const r = await hands.follow(OWNER, "whatever", "https://github.com/a/b", undefined);
    expect(r.ok).toBe(false);
  });

  test("a new upstream commit shows as drift at the next check", async () => {
    const pack = fixturePacks()[0]!;
    const a = pack.apps[0]!;
    const repo = getRepo(app.db, OWNER, a.name)!;
    const src = fake.get(a.source)!;
    const branch = git(src, "symbolic-ref", "--short", "HEAD");
    expect(getFollow(app.db, repo.id)!.behind).toBe(0);
    // The source moves on by one commit.
    await Bun.write(join(src, "f.txt"), "newer\n");
    git(src, "commit", "-qam", "upstream moved");
    const tip = git(src, "rev-parse", "HEAD");
    // The forge asks the follow's address; a local server stands for the source's host (the check refuses file: addresses).
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname.endsWith("/info/refs") ? new Response(`${tip}\trefs/heads/${branch}\n`) : new Response("no", { status: 404 })),
    });
    const dir = repoDir(app.reposRoot, OWNER, a.name);
    // The staged copy is what the check's fetch would have brought.
    git(dir, "fetch", "-q", "--no-tags", src, `+${tip}:refs/upstream-follow/${branch}`);
    // Put back what was found, not `{}`: the preload's loopback allowance is
    // what the next file in this shard mirrors from (#10507).
    const found = mirrorOutboundForTest();
    provideMirrorOutboundForTest({ allow: ["127.0.0.1"] });
    try {
      const f = getFollow(app.db, repo.id)!;
      app.db.query("UPDATE repo_upstream SET url = ?1 WHERE repo_id = ?2").run(`http://127.0.0.1:${server.port}/o/r.git`, repo.id);
      expect(f.enabled).toBe(true);
      const checked = await checkUpstream(app, getRepoById(app.db, repo.id)!);
      expect(checked.ok).toBe(true);
      expect(repo.defaultBranch).toBe(branch);
      expect(getFollow(app.db, repo.id)!.behind).toBe(1);
      expect(getFollow(app.db, repo.id)!.tip).toBe(tip);
    } finally {
      provideMirrorOutboundForTest(found);
      server.stop(true);
    }
  });
});

describe("up() itself", () => {
  test("boots a forge, deploys the pack into it with its history, says the crew is off, and stops when told", async () => {
    const d = await mkdtemp(join(tmpdir(), "packs-upcmd-"));
    const free = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = free.port!;
    free.stop(true);
    const lines: string[] = [];
    const stop = new AbortController();
    const env: Record<string, string | undefined> = { ...process.env, FORGE_SSH_PORT: "0" };
    for (const n of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FORGE_CLAUDE_CONFIG_DIR"]) delete env[n];
    try {
      const pack = fixturePacks()[0]!;
      const running = up(pack, { port, dataDir: d, cloneFrom: (s) => fake.get(s)!, say: (l) => lines.push(l), signal: stop.signal, env });
      let ended: number | undefined;
      void running.then((c) => (ended = c));
      for (let i = 0; i < 700 && ended === undefined && !lines.some((l) => l.startsWith("Your forge is serving")); i++) await Bun.sleep(100);
      if (ended !== undefined) throw new Error(`up() ended with ${ended} before serving: ${lines.join(" | ")}`);
      const said = lines.join("\n");
      expect(said).toContain(`Your forge is serving http://localhost:${port}/`);
      expect(said).toContain("crew is off until you add a model credential");
      expect(said).toContain("Sign in as \"owner\"");
      expect((await fetch(`http://localhost:${port}/${OWNER}/${pack.apps[0]!.name}`)).status).toBe(200);
      stop.abort();
      await running;
      expect(await fetch(`http://localhost:${port}/healthz`).then((r) => r.ok, () => false)).toBe(false);
      const a2 = createApp({ dataDir: d, port: 0 });
      try {
        for (const x of pack.apps) {
          const repo = getRepo(a2.db, OWNER, x.name)!;
          expect(getFollow(a2.db, repo.id)!.enabled).toBe(true);
          expect(git(repoDir(a2.reposRoot, OWNER, x.name), "rev-list", "--count", "--all")).not.toBe("0");
        }
        for (const c of pack.crew) expect([...getAgentByName(a2.db, c.username)!.roles].sort()).toEqual([...c.roles].sort());
        expect(getUserByName(a2.db, OWNER)).toBeDefined();
      } finally {
        a2.close();
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }, 120_000);
});
