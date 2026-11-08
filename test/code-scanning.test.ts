/**
 * Code scanning (#9593): a fake secret pushed over git is found by the push
 * pass, recorded without its text, shown on the findings page and the flows
 * line, and holds a release until a person with write access accepts it
 * with a reason. The fake secrets are built at run time, so this file is
 * not itself a finding.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptFinding } from "../src/actions/scan_accept.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { scanNightly, scanPush, scansSettled } from "../src/checks/scan.ts";
import { advisoryFindings, secretFindings, staticFindings, versionBelow } from "../src/checks/scan_rules.ts";
import { lastScan, listFindings, nightlyDue, openHigh } from "../src/checks/scan_store.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { scanLine } from "../src/flows/view.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { scanHold } from "../src/release/scan_hold.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const AWS = "AKIA" + "QX7Z".repeat(4);
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----";

describe("rules", () => {
  test("a secret is found and its text is not in the finding", () => {
    const found = secretFindings("config/env.ts", `const a = 1;\nconst key = "${AWS}";\n${PEM}\n`);
    expect(found.map((f) => [f.rule, f.line, f.severity])).toEqual([
      ["AWS access key", 2, "high"],
      ["Private key", 3, "high"],
    ]);
    expect(JSON.stringify(found)).not.toContain(AWS);
    expect(JSON.stringify(found)).not.toContain(AWS.slice(4));
  });
  test("a fake credential in a test is shown as medium and holds nothing", () => {
    expect(secretFindings("test/a.test.ts", `const t = "${AWS}";`).map((f) => f.severity)).toEqual(["medium"]);
    expect(secretFindings("src/fixtures/x.json", `"${AWS}"`).map((f) => f.severity)).toEqual(["medium"]);
  });
  test("binary files and plain text find nothing", () => {
    expect(secretFindings("a.bin", `\0${AWS}`)).toEqual([]);
    expect(secretFindings("a.md", "AKIA is a prefix")).toEqual([]);
  });
  test("an advisory names a pin below its fix, not one at or above it", () => {
    const pkg = JSON.stringify({ dependencies: { lodash: "^4.17.20", ws: "8.17.1" }, devDependencies: { minimist: "~1.2.5" } });
    expect(advisoryFindings("package.json", pkg).map((f) => f.rule.split(" ")[0])).toEqual(["lodash", "minimist"]);
    expect(advisoryFindings("README.md", pkg)).toEqual([]);
    expect(advisoryFindings("package.json", "{not json")).toEqual([]);
    expect(versionBelow("1.10.0", "1.9.0")).toBe(false);
    expect(versionBelow("1.2", "1.2.1")).toBe(true);
  });
  test("static analysis reads source, leaves tests and comments out, and is medium", () => {
    const src = 'const x = ev' + 'al(input);\n// ev' + 'al(no)\nel.inner' + 'HTML = v;\n';
    const found = staticFindings("src/a.ts", src);
    expect(found.map((f) => [f.rule, f.line, f.severity])).toEqual([
      ["eval of a value", 1, "medium"],
      ["HTML written from a value", 3, "medium"],
    ]);
    expect(staticFindings("test/a.test.ts", src)).toEqual([]);
    expect(staticFindings("README.md", src)).toEqual([]);
  });
});

let dataDir: string;
let work: string;
let app: App;
let servers: Servers;
let alice: User;
let reader: User;
let repo: Repo;
const token: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** The forge's own copy of the repository's default branch tip: what a release would cut. */
async function tipOf(branch = "main"): Promise<string> {
  const dir = join(dataDir, "repos", "alice", "square.git");
  return (await git(["rev-parse", branch], dir)).out.trim();
}

async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: gitClientEnv(), stdout: "pipe", stderr: "pipe" });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + errText };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-scan-"));
  work = await mkdtemp(join(tmpdir(), "forge-scan-work-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true }));
  reader = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "rita", email: "rita@forge.local", password: "a-good-passphrase" }));
  repo = ok(await createRepo(app, alice, { name: "square", visibility: "public" }));
  ok(await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# square\n" }] }));
  token.alice = createToken(app.db, alice.id, "t", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("a push", () => {
  test("a pushed fake secret is found, without its text", async () => {
    const url = `${servers.url.replace("http://", `http://alice:${token.alice}@`)}/alice/square.git`;
    const clone = join(work, "square");
    expect((await git(["clone", "-q", url, clone], work)).code).toBe(0);
    await writeFile(join(clone, "deploy.ts"), `export const key = "${AWS}";\n`);
    await writeFile(join(clone, "package.json"), JSON.stringify({ dependencies: { lodash: "4.17.15" } }));
    expect((await git(["add", "."], clone)).code).toBe(0);
    expect((await git(["-c", "user.name=a", "-c", "user.email=a@x", "commit", "-qm", "oops"], clone)).code).toBe(0);
    const pushed = await git(["push", "-q", "origin", "HEAD:main"], clone);
    expect(pushed.code).toBe(0);
    // The scan runs off the hook's answer: wait on the scan itself, not on a clock.
    await scansSettled(app, repo.id);
    const found = listFindings(app.db, repo.id);
    expect(found.map((f) => [f.kind, f.path, f.line]).sort()).toEqual([
      ["advisory", "package.json", 0],
      ["secret", "deploy.ts", 1],
    ]);
    const page = await (await fetch(`${servers.url}/alice/square/findings`)).text();
    expect(page).toContain("AWS access key");
    expect(page).toContain("deploy.ts:1");
    expect(page).not.toContain(AWS.slice(4));
    const flows = await (await fetch(`${servers.url}/alice/square/flows`)).text();
    expect(flows).toContain("Code scanning");
    expect(flows).toContain("2 high findings hold releases");
  }, 30_000);

  test("a high finding holds a release; acceptance with a reason lifts it", async () => {
    const hold = await scanHold(app, repo, await tipOf());
    expect(hold.held).toBe(true);
    if (hold.held) expect(hold.line).not.toContain(AWS.slice(4));
    const [secret, advisory] = openHigh(app.db, repo.id).sort((a, b) => (a.kind < b.kind ? 1 : -1));
    const bot = ok(await createAgent(app, alice, { username: "bot" }));
    expect(acceptFinding(app, repo, bot.user, secret!.id, "the crew says so")).toMatchObject({ ok: false, status: 403 });
    expect(acceptFinding(app, repo, reader, secret!.id, "not mine to say")).toMatchObject({ ok: false, status: 403 });
    expect(acceptFinding(app, repo, alice, secret!.id, "  ")).toMatchObject({ ok: false, status: 400 });
    expect(acceptFinding(app, repo, alice, 999_999, "no such")).toMatchObject({ ok: false, status: 404 });
    expect(acceptFinding(app, repo, alice, secret!.id, "Rotated: the key is revoked")).toEqual({ ok: true });
    expect(acceptFinding(app, repo, alice, secret!.id, "again")).toMatchObject({ ok: false, status: 409 });
    expect((await scanHold(app, repo, await tipOf())).held).toBe(true);
    // Through the page's form, as a person does it.
    const res = await fetch(`${servers.url}/alice/square/findings/${advisory!.id}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.alice}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ reason: "Dev only, upgrade tracked" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(await scanHold(app, repo, await tipOf())).toEqual({ held: false });
    const accepted = listFindings(app.db, repo.id).find((f) => f.id === secret!.id)!;
    expect(accepted.accepted).toMatchObject({ by: "alice", reason: "Rotated: the key is revoked" });
    expect(scanLine(app.db, repo).state).toBe("no open findings");
  });

  test("the nightly pass adds static analysis over the default branch and is then not due", async () => {
    ok(await commitToBranch(app, alice, repo, { message: "html", files: [{ path: "src/view.js", content: "el.inner" + "HTML = name;\n" }] }));
    expect(nightlyDue(app.db, new Date().toISOString(), 10)).toContain(repo.id);
    await scanNightly(app, repo);
    expect(listFindings(app.db, repo.id).some((f) => f.kind === "static" && f.path === "src/view.js")).toBe(true);
    expect(nightlyDue(app.db, new Date(Date.now() - 3_600_000).toISOString(), 10)).not.toContain(repo.id);
    expect((await scanHold(app, repo, await tipOf())).held).toBe(false);
  });

  test("a push of many new branches is scanned against main in a bounded number of git processes", async () => {
    const clone = join(work, "square");
    expect((await git(["fetch", "-q", "origin", "main"], clone)).code).toBe(0);
    let stream = "";
    for (let i = 0; i < 20; i++) {
      const leak = i === 0 ? `M 100644 inline leak.ts\ndata ${`const k = "${AWS}";\n`.length}\nconst k = "${AWS}";\n` : `M 100644 inline n${i}.txt\ndata 2\nn\n`;
      stream += `commit refs/heads/feat/b${i}\ncommitter A <a@x> ${1700000000 + i} +0000\ndata 2\nb\nfrom refs/remotes/origin/main\n${leak}\n`;
    }
    const fi = Bun.spawn(["git", "fast-import", "--quiet"], { cwd: clone, env: gitClientEnv(), stdin: new TextEncoder().encode(stream), stderr: "pipe" });
    expect(await fi.exited).toBe(0);
    expect((await git(["push", "-q", "origin", "refs/heads/feat/*:refs/heads/feat/*"], clone)).code).toBe(0);
    const tip = (await git(["rev-parse", "feat/b0"], clone)).out.trim();
    const leakAt = () => listFindings(app.db, repo.id).filter((f) => f.oid === tip);
    await scansSettled(app, repo.id);
    // Compared with main: the branch's own file, not main's files again.
    expect(leakAt().map((f) => f.path)).toEqual(["leak.ts"]);
    const updates = [];
    for (let i = 0; i < 20; i++) {
      updates.push({ ref: `refs/heads/feat/b${i}`, oldOid: "0".repeat(40), newOid: (await git(["rev-parse", `feat/b${i}`], clone)).out.trim() });
    }
    // An open high finding on a branch that never reached main holds no release of main.
    expect(openHigh(app.db, repo.id).map((f) => f.path)).toEqual(["leak.ts"]);
    expect(await scanHold(app, repo, await tipOf())).toEqual({ held: false });
    expect((await scanHold(app, repo, tip)).held).toBe(true);
    const spy = spyOn(Bun, "spawn");
    try {
      expect(await scanPush(app, repo, updates)).toBe(0);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test("a secret removed from main stops holding its release without an acceptance", async () => {
    const before = await tipOf();
    ok(await commitToBranch(app, alice, repo, { message: "leak", files: [{ path: "config/prod.ts", content: `export const k = "${PEM}";\n` }] }));
    const leaked = await tipOf();
    await scanPush(app, repo, [{ ref: "refs/heads/main", oldOid: before, newOid: leaked }]);
    expect((await scanHold(app, repo, leaked)).held).toBe(true);
    ok(await commitToBranch(app, alice, repo, { message: "rotate", files: [{ path: "config/prod.ts", content: "export const k = process.env.K;\n" }] }));
    const clean = await tipOf();
    expect(await scanHold(app, repo, clean)).toEqual({ held: false });
    // The old tree still holds it: the hold reads what is released, not a flag.
    expect((await scanHold(app, repo, leaked)).held).toBe(true);
  });

  test("a file named with a newline is skipped and counted, and later files keep their own text", async () => {
    const clone = join(work, "square");
    expect((await git(["checkout", "-q", "-b", "nl", "origin/main"], clone)).code).toBe(0);
    expect((await git(["pull", "-q", "origin", "main"], clone)).code).toBe(0);
    await writeFile(join(clone, "a\nb.txt"), "plain\n");
    await writeFile(join(clone, "b.txt"), "nothing here\n");
    await writeFile(join(clone, "c.ts"), `\n\nexport const key = "${AWS}";\n`);
    expect((await git(["add", "."], clone)).code).toBe(0);
    expect((await git(["-c", "user.name=a", "-c", "user.email=a@x", "commit", "-qm", "nl"], clone)).code).toBe(0);
    const base = (await git(["rev-parse", "HEAD~1"], clone)).out.trim();
    const head = (await git(["rev-parse", "HEAD"], clone)).out.trim();
    expect((await git(["push", "-q", "origin", "nl"], clone)).code).toBe(0);
    await scansSettled(app, repo.id);
    await scanPush(app, repo, [{ ref: "refs/heads/nl", oldOid: base, newOid: head }]);
    const at = listFindings(app.db, repo.id).filter((f) => f.oid === head);
    expect(at.map((f) => [f.path, f.line])).toEqual([["c.ts", 3]]);
    expect(lastScan(app.db, repo.id, "push")?.skipped).toBe(1);
    const page = await (await fetch(`${servers.url}/alice/square/findings`)).text();
    expect(page).toContain("partial: 1 file not read");
  });
});
