/**
 * A sealed report's fix is not in anything a stranger can read (#621).
 * The crew works it in a private repository of its own, read by the
 * base's writers and crew only; the pull that proposes it keeps its head
 * there (`pullDir`), and the base never holds its objects before it merges.
 * So a stranger and a reader cannot list it, clone it, fetch it by sha
 * under either protocol, or read it through any page or API, on the base
 * or on the private repository; a writer and the crew can.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  sealedForkFor,
} from "../src/actions/repos.ts";
import type { Agent } from "../src/core/agents.ts";
import { listEvents, listEventsVisibleTo } from "../src/core/events.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { getPull, pullDiff, pullDir } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { forkFor } from "../src/crew/runner.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let work: string;
let app: App;
let servers: Servers;
let alice: User;
let mallory: User;
let bot: Agent;
let repo: Repo;
let sealedRepo: Repo;
let fixOid = "";
let pullNumber = 0;
const token: Record<string, string> = {};

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** Run git as a client; the exit code and what it said. */
async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + errText };
}

/** A clone URL as `who` (none: anonymous). */
const remote = (path: string, who?: string) =>
  who === undefined
    ? `${servers.url}/${path}.git`
    : `${servers.url.replace("http://", `http://${who}:${token[who]}@`)}/${path}.git`;

async function get(
  path: string,
  who?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${servers.url}${path}`, {
    headers: who === undefined ? {} : { authorization: `Bearer ${token[who]}` },
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sealed-git-"));
  work = await mkdtemp(join(tmpdir(), "forge-sealed-git-work-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  mallory = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "a-good-passphrase",
    }),
  );
  bot = ok(await createAgent(app, alice, { username: "bot" }));
  repo = ok(
    await createRepo(app, alice, { name: "square", visibility: "public" }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# square\n" }],
    }),
  );
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  for (const u of [alice, mallory, bot.user])
    token[u.username] = createToken(app.db, u.id, "t", "rw").token;

  const report = ok(
    openIssue(app, alice, repo, {
      title: "Hole",
      body: "detail",
      sealed: true,
    }),
  );
  // The crew's private place for the base's sealed work, and the fix in it.
  sealedRepo = ok(await sealedForkFor(app, bot.user, repo));
  ok(
    await commitToBranch(app, bot.user, sealedRepo, {
      branch: `bot/${report.number}`,
      base: "main",
      message: "Fix the hole",
      files: [{ path: "fix.ts", content: "export const X9QFIX = true;\n" }],
    }),
  );
  const pull = ok(
    await openPull(app, bot.user, repo, {
      title: "Fix",
      body: `Closes #${report.number}`,
      baseBranch: "main",
      headBranch: `bot/${report.number}`,
      headRepo: sealedRepo,
    }),
  );
  expect(pull.sealed).toBe(true);
  fixOid = pull.headOid;
  pullNumber = pull.number;
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("where the fix lives", () => {
  test("the crew's place for sealed work is private, out of the fork graph, made once", async () => {
    expect(sealedRepo.visibility).toBe("private");
    expect(sealedRepo.forkParentId).toBeNull();
    expect(sealedRepo.sealedFor).toBe(repo.id);
    expect((await sealedForkFor(app, bot.user, repo)).ok).toBe(true);
    expect(ok(await sealedForkFor(app, bot.user, repo)).id).toBe(sealedRepo.id);
  });

  test("the base never holds the fix's objects; its pull is read where the work is", async () => {
    const base = repoDir(app.reposRoot, repo.ownerName, repo.name);
    expect((await git(["cat-file", "-e", fixOid], base)).code).not.toBe(0);
    const pull = getPull(app.db, repo.id, pullNumber)!;
    const at = await pullDir(app.db, app.reposRoot, repo, pull);
    expect(at).not.toBe(base);
    const { diff } = await pullDiff(at, pull);
    expect(diff.files.map((f) => f.path)).toEqual(["fix.ts"]);
  });

  test("the crew's runner works a sealed task there, and an ordinary one in its public fork", async () => {
    const sealedPlace = await forkFor(app, bot, repo, () => {}, true);
    expect(sealedPlace.ok && sealedPlace.value.id).toBe(sealedRepo.id);
    const ordinary = await forkFor(app, bot, repo, () => {}, false);
    expect(ordinary.ok && ordinary.value.visibility).toBe("public");
    expect(ordinary.ok && ordinary.value.id).not.toBe(sealedRepo.id);
  });

  test("its owner cannot make it public", async () => {
    const res = await fetch(
      `${servers.url}/api/v1/repos/bot/${sealedRepo.name}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${createToken(app.db, bot.user.id, "a", "admin").token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ visibility: "public" }),
      },
    );
    expect(res.status).toBe(404);
    expect(getRepoById(app.db, sealedRepo.id)!.visibility).toBe("private");
  });
});

describe("a stranger and a reader cannot reach the fix", () => {
  for (const who of [undefined, "mallory"] as const)
    test(`${who ?? "a stranger"}: not by git, on the base or the private place`, async () => {
      // The base's advertisement never names it.
      const listed = await git(
        ["ls-remote", remote("alice/square", who)],
        work,
      );
      expect(listed.code).toBe(0);
      expect(listed.out).not.toContain(fixOid);
      expect(listed.out).not.toContain(`refs/pull/${pullNumber}/head`);
      // Nor can it be fetched from the base by sha, under either protocol.
      for (const version of ["0", "2"]) {
        const dir = await mkdtemp(join(work, "f-"));
        await git(["init", "-q"], dir);
        const fetched = await git(
          [
            "-c",
            `protocol.version=${version}`,
            "fetch",
            remote("alice/square", who),
            fixOid,
          ],
          dir,
        );
        expect({ version, code: fetched.code === 0 }).toEqual({
          version,
          code: false,
        });
        expect((await git(["cat-file", "-e", fixOid], dir)).code).not.toBe(0);
      }
      // The private place: no listing, no clone.
      const priv = await git(
        ["ls-remote", remote(`bot/${sealedRepo.name}`, who)],
        work,
      );
      expect(priv.code).not.toBe(0);
      const cloned = await git(
        [
          "clone",
          "-q",
          remote(`bot/${sealedRepo.name}`, who),
          `c-${who ?? "anon"}`,
        ],
        work,
      );
      expect(cloned.code).not.toBe(0);
    });

  for (const who of [undefined, "mallory"] as const)
    test(`${who ?? "a stranger"}: not by any page or API`, async () => {
      for (const path of [
        `/api/v1/repos/alice/square/contents/fix.ts?ref=${fixOid}`,
        `/api/v1/repos/alice/square/commits/${fixOid}`,
        `/alice/square/raw/${fixOid}/fix.ts`,
        `/alice/square/blob/${fixOid}/fix.ts`,
        `/alice/square/tree/${fixOid}`,
        `/alice/square/commit/${fixOid}`,
        `/api/v1/repos/bot/${sealedRepo.name}`,
        `/api/v1/repos/bot/${sealedRepo.name}/branches`,
        `/api/v1/repos/bot/${sealedRepo.name}/contents/fix.ts?ref=bot/1`,
        `/bot/${sealedRepo.name}`,
        `/bot/${sealedRepo.name}/raw/${fixOid}/fix.ts`,
      ]) {
        const { status, text } = await get(path, who);
        expect({
          path,
          found: status === 200,
          leaks: text.includes("X9QFIX"),
        }).toEqual({
          path,
          found: false,
          leaks: false,
        });
      }
    });

  test("no answer about it may sit in a shared cache, for a stranger or for the writer who can read it", async () => {
    expect(sealedRepo.visibility).not.toBe("public");
    const session = createSession(app.db, alice.id).token;
    for (const path of [`raw/${fixOid}/fix.ts`, `media/${fixOid}/fix.ts`, `blob/${fixOid}/fix.ts`, `tree/${fixOid}`, `commit/${fixOid}`]) {
      for (const base of ["alice/square", `bot/${sealedRepo.name}`]) {
        for (const headers of [{}, { cookie: `forge_session=${session}` }] as Record<string, string>[]) {
          const answer = await fetch(`${servers.url}/${base}/${path}`, { headers, redirect: "manual" });
          expect({ path, base, control: (answer.headers.get("cache-control") ?? "").includes("public") }).toEqual({ path, base, control: false });
        }
      }
    }
  });

  test("the push that carried it reaches neither a reader's events nor the base's", async () => {
    for (const viewer of [undefined, mallory]) {
      const seen = listEventsVisibleTo(app.db, viewer).filter(
        audienceFilter(app.db, viewer),
      );
      expect(JSON.stringify(seen)).not.toContain(fixOid);
    }
    expect(JSON.stringify(listEvents(app.db, { repoId: repo.id }))).not.toContain(fixOid);
    for (const who of [undefined, "mallory"] as const) {
      const { status } = await get(`/api/v1/repos/bot/${sealedRepo.name}/events`, who);
      expect(status).toBe(404);
    }
  });
});

describe("a writer and the crew can", () => {
  for (const who of ["alice", "bot"] as const)
    test(`${who} fetches the fix from the private place to review it`, async () => {
      const dir = await mkdtemp(join(work, `w-${who}-`));
      await git(["init", "-q"], dir);
      const fetched = await git(
        ["fetch", remote(`bot/${sealedRepo.name}`, who), `bot/1`],
        dir,
      );
      expect(fetched.code).toBe(0);
      expect((await git(["cat-file", "-e", fixOid], dir)).code).toBe(0);
    });
});

describe("landing it", () => {
  test("a writer merges it: then, and only then, the base holds it", async () => {
    const pull = getPull(app.db, repo.id, pullNumber)!;
    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
    const base = repoDir(app.reposRoot, repo.ownerName, repo.name);
    expect((await git(["cat-file", "-e", fixOid], base)).code).toBe(0);
  });
});
