/**
 * A run gets exactly the secrets it declares, for that run only, and a
 * value never reaches a log, an event, or a commit.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { createApp, type App } from "../src/app.ts";
import { grantSecrets, parseDeclaration } from "../src/crew/grant.ts";
import { historyHolds, scrubTree } from "../src/crew/leak.ts";
import { listHeldSecrets, releaseOrphans } from "../src/core/run_secret.ts";
import { setSecret } from "../src/core/secret_store.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";
import { runGit } from "../src/git/env.ts";
import { redactHeld } from "../src/kernel/log.ts";
import { appendRunLog, readRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const VALUE = "cf-live-7Hq2xZp9LmN4vB8w";
let run = { id: "run1", repoId: "", ownerId: "", actorId: "" };

describe("declaring secrets", () => {
  test("names and hosts are read from front-matter", () => {
    const d = parseDeclaration(
      "---\nsecrets: CF_TOKEN@API.cloudflare.com, BUCKET_KEY\n---\nbody",
    );
    expect(d.names).toEqual(["CF_TOKEN", "BUCKET_KEY"]);
    expect(d.hosts).toEqual(["api.cloudflare.com"]);
    expect(d.refused).toEqual([]);
  });

  test("text without front-matter at the top declares nothing", () => {
    expect(parseDeclaration("hello\n---\nsecrets: CF_TOKEN\n---").names).toEqual([]);
  });

  test("bad names, reserved names and bad hosts are refused", () => {
    const d = parseDeclaration(
      "---\nsecrets: lower, FORGE_TOKEN, PATH, GIT_ASKPASS, OK@evil host, OK2@a.com/x\n---",
    );
    expect(d.names).toEqual([]);
    expect(d.refused.length).toBe(6);
  });
});

describe("a grant", () => {
  let dataDir = "";
  let app: App;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-run-secrets-"));
    app = createApp({ dataDir, port: 0 });
    const u = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const r = await createRepo(app, u.value, { name: "site", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    run = { id: "run1", repoId: r.value.id, ownerId: r.value.ownerId, actorId: u.value.id };
    setSecret(app.db, dataDir, "forge", "", "CF_TOKEN", VALUE);
    setSecret(app.db, dataDir, "forge", "", "UNDECLARED", "other-value-1234");
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("carries only declared names, widens egress by their hosts, and ends", () => {
    const d = parseDeclaration(
      "---\nsecrets: CF_TOKEN@api.cloudflare.com, MISSING@unused.example.com\n---",
    );
    const grant = grantSecrets(app.db, dataDir, app.bus, d, run);
    expect(grant.env).toEqual({ CF_TOKEN: VALUE });
    expect(grant.missing).toEqual(["MISSING"]);
    expect(grant.hosts).toEqual(["api.cloudflare.com"]);
    expect(listHeldSecrets(app.db, "run1")).toEqual([
      { name: "CF_TOKEN", scope: "forge", releasedAt: null },
    ]);

    const policy = sandboxPolicy({
      dataDir,
      agentName: "scout",
      urls: [],
      extraHosts: grant.hosts,
    });
    expect(policy.allowHosts).toContain("api.cloudflare.com");
    expect(sandboxPolicy({ dataDir, agentName: "scout", urls: [] }).allowHosts).not.toContain(
      "api.cloudflare.com",
    );

    // While held: never in a log line, in any common encoding, or an event.
    appendRunLog(dataDir, "run1", `curl said ${VALUE} and ${btoa(VALUE)}`);
    appendRunLog(dataDir, "run1", `encoded ${encodeURIComponent(VALUE)}`);
    const logged = readRunLog(dataDir, "run1").lines.join("\n");
    expect(logged).not.toContain(VALUE);
    expect(logged).not.toContain(btoa(VALUE));
    const ev = app.bus.append({ kind: "run.note", payload: { nested: [`x ${VALUE}`] } });
    expect(JSON.stringify(ev.payload)).not.toContain(VALUE);
    const row = app.db
      .query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'run.note'")
      .get()!;
    expect(row.payload).not.toContain(VALUE);
    // The audit of the open names the secret, never the value.
    const reads = app.db
      .query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'secret.read'")
      .all();
    expect(reads.length).toBe(1);
    expect(reads[0]!.payload).toContain("CF_TOKEN");
    expect(reads[0]!.payload).not.toContain(VALUE);

    grant.release();
    expect(listHeldSecrets(app.db, "run1")[0]!.releasedAt).not.toBeNull();
    expect(redactHeld(`plain ${VALUE}`)).toContain(VALUE);
  });

  test("a crash's open grant is closed by the sweep", () => {
    const d = parseDeclaration("---\nsecrets: CF_TOKEN\n---");
    grantSecrets(app.db, dataDir, app.bus, d, { ...run, id: "run2" });
    expect(listHeldSecrets(app.db, "run2")[0]!.releasedAt).toBeNull();
    expect(releaseOrphans(app.db)).toBe(1);
    expect(listHeldSecrets(app.db, "run2")[0]!.releasedAt).not.toBeNull();
  });
});

describe("a value echoed into a file", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-leak-"));
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "a@b.c"],
      ["config", "user.name", "a"],
      ["commit", "-q", "--allow-empty", "-m", "base"],
    ])
      await runGit(args, { cwd: dir });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("is scrubbed from the tree before the forge commits it", async () => {
    await writeFile(join(dir, "main.tf"), `token = "${VALUE}"\n`);
    const touched = await scrubTree(dir, [VALUE], {});
    expect(touched).toEqual(["main.tf"]);
    expect(await readFile(join(dir, "main.tf"), "utf8")).not.toContain(VALUE);
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(["commit", "-q", "-m", "clean"], { cwd: dir });
    expect(await historyHolds(dir, "HEAD~1..HEAD", [VALUE], {})).toBe(false);
  });

  test("is found in a commit the agent made itself", async () => {
    await writeFile(join(dir, "leak.txt"), `${btoa(VALUE)}\n`);
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(["commit", "-q", "-m", "oops"], { cwd: dir });
    expect(await historyHolds(dir, "HEAD~1..HEAD", [VALUE], {})).toBe(true);
    expect(await historyHolds(dir, "HEAD~1..HEAD", ["unrelated-value"], {})).toBe(false);
  });
});
