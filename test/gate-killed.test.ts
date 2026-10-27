/**
 * A gate whose check a signal from outside ended — the pod going, the
 * kernel's OOM killer — is no verdict (#6722): the check never said red,
 * so the gate answers `interrupted`, as one the forge stopping cut off
 * does, and the merge queue hands no one back and marks no suspect. A
 * check that exits red on its own is still red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { killedStep, runStep } from "../src/apps/process.ts";
import { gateCandidate } from "../src/checks/landing.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { getPull } from "../src/core/pulls.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";

describe("a step a signal from outside ended", () => {
  const step = (command: string) =>
    runStep("check", command, { cwd: tmpdir(), env: { PATH: process.env["PATH"] ?? "" }, log: () => {}, signal: new AbortController().signal });

  test("says it was killed, by which signal, whether the shell or its child took it", async () => {
    const own = await step("kill -KILL $$");
    expect(own).toEqual({ ok: false, error: "check was killed by SIGKILL" });
    const child = await step("sh -c 'kill -TERM $$'; exit $?");
    expect(child).toEqual({ ok: false, error: "check was killed by SIGTERM" });
    expect(killedStep(own.ok ? "" : own.error)).toBe(true);
  });

  test("a step that exits red on its own was not killed", async () => {
    const red = await step("exit 1");
    expect(red.ok).toBe(false);
    expect(killedStep(red.ok ? "" : red.error)).toBe(false);
  });
});

describe("a gate on land whose check was killed", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let alice: User;
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-gate-killed-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 2 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
  });

  afterAll(async () => {
    await checks.stop({ drain: false });
    app.close();
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Gate a pull of a repository whose full check is `full`. */
  async function gateWith(name: string, full: string) {
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true", full } }) }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branched = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Touch b",
      files: [{ path: "b.txt", content: "b\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, repo, { title: "Feature", baseBranch: "main", headBranch: "feature" });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    return gateCandidate(app, repo, pull, repoDir(app.reposRoot, repo.ownerName, repo.name), pull.headOid);
  }

  test("answers interrupted, not red (check)", async () => {
    expect(await gateWith("killed", "echo test/slow.test.ts:; kill -KILL $$")).toEqual({ lands: false, interrupted: true });
  }, 30_000);

  test("a check that exits red on its own is red (check)", async () => {
    const verdict = await gateWith("exited", "echo test/slow.test.ts:; exit 1");
    expect(verdict).toMatchObject({ lands: false, reason: { kind: "check" } });
  }, 30_000);
});
