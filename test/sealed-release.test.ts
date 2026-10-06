/**
 * The way in and the way out of a sealed report (#621): the forge's
 * security.txt and a public repository's page say how to report privately,
 * and a report opens to everyone once a release carries its fix — a tag
 * whose commit contains the merged pull that closed it — never before.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { unsealReleased } from "../src/actions/sealed.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let mallory: User;
let bot: User;
let repo: Repo;
let baseOid = "";
let aliceRw = "";

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** A sealed report, and a merged pull that closes it. */
async function reportAndFix(
  slug: string,
): Promise<{ report: Issue; mergeOid: string; pull: number }> {
  const report = ok(
    openIssue(app, alice, repo, {
      title: `Hole ${slug}`,
      body: "detail",
      sealed: true,
    }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      branch: `fix/${slug}`,
      base: "main",
      message: `Fix ${slug}`,
      files: [{ path: `${slug}.ts`, content: "export const fixed = true;\n" }],
    }),
  );
  const pull = ok(
    await openPull(app, alice, repo, {
      title: `Fix ${slug}`,
      body: `Closes #${report.number}`,
      baseBranch: "main",
      headBranch: `fix/${slug}`,
    }),
  );
  expect(pull.sealed).toBe(true);
  const merged = ok(await mergePull(app, alice, repo, pull, "squash"));
  return { report, mergeOid: merged.mergeOid, pull: pull.number };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sealed-release-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(
    await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  mallory = ok(
    await createUser(app.db, {
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "a-good-passphrase",
    }),
  );
  repo = ok(
    await createRepo(app, alice, { name: "square", visibility: "public" }),
  );
  baseOid = ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# square\n" }],
    }),
  ).commitOid;
  const agent = ok(await createAgent(app, alice, { username: "bot" }));
  bot = agent.user;
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  aliceRw = createToken(app.db, alice.id, "push", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the way in", () => {
  test("security.txt says how to report a problem in a repository privately", async () => {
    const text = await (
      await fetch(`${servers.url}/.well-known/security.txt`)
    ).text();
    expect(text).toContain('"Sealed security report"');
    expect(text).toContain("/issues/new?sealed=1");
  });

  test("a public repository's page links to a sealed report, and the form comes ticked", async () => {
    const page = await (await fetch(`${servers.url}/alice/square`)).text();
    expect(page).toContain("/alice/square/issues/new?sealed=1");
    const token = createToken(app.db, mallory.id, "t", "rw").token;
    const form = await (
      await fetch(`${servers.url}/alice/square/issues/new?sealed=1`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).text();
    expect(form).toMatch(/name="sealed"\s+checked/);
  });
});

describe("the way out: its fix released", () => {
  test("a tag that does not contain the fix opens nothing", async () => {
    const { report, pull } = await reportAndFix("early");
    const opened = await unsealReleased(app, repo, [
      { ref: "refs/tags/v0", newOid: baseOid },
    ], alice);
    expect(opened).toEqual([]);
    expect(getIssue(app.db, repo.id, report.number)!.sealed).toBe(true);
    expect(getPull(app.db, repo.id, pull)!.sealed).toBe(true);
    // Nor does a branch, however far it has come.
    expect(
      await unsealReleased(app, repo, [
        { ref: "refs/heads/main", newOid: baseOid },
      ], alice),
    ).toEqual([]);
  });

  test("a tag that contains the merged fix unseals the report and its pull, recorded as the release's", async () => {
    const { report, mergeOid, pull } = await reportAndFix("late");
    const opened = await unsealReleased(app, repo, [
      { ref: "refs/tags/v1.0.1", newOid: mergeOid },
    ], alice);
    expect(opened).toContain(report.number);
    expect(opened).toContain(pull);
    expect(getIssue(app.db, repo.id, report.number)!.sealed).toBe(false);
    expect(getPull(app.db, repo.id, pull)!.sealed).toBe(false);
    const record = listEvents(app.db, { repoId: repo.id }).find(
      (e) =>
        e.kind === "issue.unsealed" && e.payload["number"] === report.number,
    );
    expect(record?.payload["released"]).toBe("v1.0.1");
  });
});

describe("a release is a person's", () => {
  test("a tag an agent or a reader pushes opens nothing, even one that contains the fix", async () => {
    const { report, mergeOid } = await reportAndFix("asked");
    for (const pusher of [bot, mallory, undefined])
      expect(
        await unsealReleased(
          app,
          repo,
          [{ ref: "refs/tags/v9", newOid: mergeOid }],
          pusher,
        ),
      ).toEqual([]);
    expect(getIssue(app.db, repo.id, report.number)!.sealed).toBe(true);
  });

  test("through a real git push of a writer's tag, the report opens", async () => {
    const { report, mergeOid } = await reportAndFix("pushed");
    const work = await mkdtemp(join(tmpdir(), "forge-sealed-tag-"));
    const git = async (args: string[], cwd = work) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        env: gitClientEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      return proc.exited;
    };
    const as = (who: User, token: string) =>
      `${servers.url.replace("http://", `http://${who.username}:${token}@`)}/alice/square.git`;
    expect(await git(["clone", "-q", as(alice, aliceRw), "c"])).toBe(0);
    const dir = join(work, "c");
    // A crew agent cannot push to the base at all here; one that could is
    // refused by the release rule above. A writer tags it: the report opens.
    expect(await git(["tag", "v-person", mergeOid], dir)).toBe(0);
    expect(await git(["push", "-q", "origin", "v-person"], dir)).toBe(0);
    const deadline = Date.now() + 10_000;
    while (getIssue(app.db, repo.id, report.number)!.sealed && Date.now() < deadline)
      await Bun.sleep(100);
    expect(getIssue(app.db, repo.id, report.number)!.sealed).toBe(false);
    await rm(work, { recursive: true, force: true });
  });
});

describe("what is assigned to you", () => {
  test("a sealed report assigned to someone who may not see it is not on their list", async () => {
    const hidden = ok(
      openIssue(app, alice, repo, {
        title: "X9QASSIGNED",
        body: "",
        sealed: true,
      }),
    );
    expect(assignIssue(app, alice, repo, hidden, mallory).ok).toBe(true);
    const token = createToken(app.db, mallory.id, "t2", "rw").token;
    const listed = await (
      await fetch(`${servers.url}/api/v1/user/assigned`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).text();
    expect(listed).not.toContain("X9QASSIGNED");
  });
});
