/**
 * The releases a forge has shipped are the frozen ones and its annotated
 * `v*` tags, newest first; a cut is a tag, so main never moves (#6642).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationFiles, NUMBERED } from "../src/core/schema.ts";
import { releasesBehind } from "../src/spawn/heartbeat.ts";
import {
  compareVersions,
  mergeShipped,
  parseRecord,
  readTagged,
  recordFor,
  setTagged,
  shippedReleases,
} from "../src/release/shipped.ts";
import { ownTagsReader, readOwnTags } from "../src/release/own_tags.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Log, LogFields } from "../src/kernel/log.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-shipped-"));
});
afterAll(async () => {
  setTagged([]);
  await rm(dir, { recursive: true, force: true });
});

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args: string[], date: string, stdin?: string) =>
  Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...env, GIT_COMMITTER_DATE: date },
    stdout: "ignore",
    stderr: "ignore",
    ...(stdin === undefined ? {} : { stdin: new Blob([stdin]) }),
  }).exited;

describe("a release record", () => {
  test("is read from a tag message, and anything else is not one", () => {
    expect(parseRecord('{"version":"0.7.272","migrations":151,"ids":["20261016130000-usage-count"]}\n')).toEqual({
      version: "0.7.272",
      migrations: 151,
      ids: ["20261016130000-usage-count"],
    });
    expect(parseRecord('{"version":"0.7.40","migrations":40}')).toEqual({ version: "0.7.40", migrations: 40 });
    const signed = '{"version":"1.0.0","migrations":1}\n-----BEGIN PGP SIGNATURE-----\nxyz\n-----END PGP SIGNATURE-----\n';
    expect(parseRecord(signed)).toEqual({ version: "1.0.0", migrations: 1 });
    for (const bad of [
      "forge 0.3.9 — git trusts the runtime's extra certificate authority",
      "{",
      '{"version":"a b; rm","migrations":1}',
      '{"version":"1.0.0","migrations":-1}',
      '{"version":"1.0.0","migrations":1.5}',
      '{"version":"1.0.0","migrations":1,"ids":["../x"]}',
      '{"version":"1.0.0","migrations":1,"ids":"x"}',
      "null",
    ])
      expect(parseRecord(bad)).toBeUndefined();
  });

  test("of a cut counts every migration and names the stamped ones", () => {
    const record = recordFor("9.0.0", migrationFiles, NUMBERED);
    expect(record.migrations).toBe(migrationFiles.length);
    expect(record.ids).toEqual(migrationFiles.slice(NUMBERED).map((m) => m.name));
    expect(parseRecord(JSON.stringify(record))).toEqual(record);
  });

  test("versions sort newest first, by number", () => {
    expect(["0.7.9", "0.7.271", "0.10.0", "0.7.10"].sort(compareVersions)).toEqual(["0.10.0", "0.7.271", "0.7.10", "0.7.9"]);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("the shipped releases", () => {
  test("are the frozen ones until a tag is read, then the tags ahead of them", () => {
    const frozen = shippedReleases();
    expect(frozen.length).toBeGreaterThan(0);
    expect(shippedReleases()).toBe(frozen);
    expect(releasesBehind(frozen[0]!.version)).toBe(0);
    setTagged([{ version: "99.0.1", migrations: 1, at: 2 }, { version: "99.0.0", migrations: 1, at: 1 }]);
    expect(shippedReleases().slice(0, 3).map((r) => r.version)).toEqual(["99.0.1", "99.0.0", frozen[0]!.version]);
    expect(shippedReleases().length).toBe(frozen.length + 2);
    // A child on the newest frozen release is now two behind.
    expect(releasesBehind(frozen[0]!.version)).toBe(2);
    setTagged([]);
    expect(shippedReleases()).toBe(frozen);
  });

  test("a tag wins over the frozen entry of its version", () => {
    const merged = mergeShipped([{ version: "1.0.0", migrations: 1 }], [{ version: "1.0.0", migrations: 2, at: 5 }]);
    expect(merged).toEqual([{ version: "1.0.0", migrations: 2, at: 5 }]);
  });

  test("are read from the annotated v* tags; a lightweight or wordy tag is no record", async () => {
    await git(["init", "-q", "-b", "main"], "2026-10-26T10:00:00Z");
    await git(["commit", "-q", "--allow-empty", "-m", "one"], "2026-10-26T10:00:00Z");
    await git(["tag", "-a", "-F", "-", "v0.3.9"], "2026-09-09T19:54:19Z", "forge 0.3.9 — words, not a record");
    await git(["tag", "v0.7.300"], "2026-10-26T10:00:00Z");
    await git(["tag", "-a", "-F", "-", "not-a-release"], "2026-10-26T10:00:00Z", '{"version":"5.0.0","migrations":1}');
    await git(["tag", "-a", "-F", "-", "v0.7.272"], "2026-10-26T11:00:00Z", '{"version":"0.7.272","migrations":151,"ids":["a-b"]}');
    await git(["tag", "-a", "-F", "-", "v0.7.273"], "2026-10-26T12:00:00Z", '{\n  "version": "0.7.273",\n  "migrations": 152\n}\n');
    expect(await readTagged(dir)).toEqual([
      { version: "0.7.273", migrations: 152, at: Date.parse("2026-10-26T12:00:00Z") },
      { version: "0.7.272", migrations: 151, ids: ["a-b"], at: Date.parse("2026-10-26T11:00:00Z") },
    ]);
    expect(await readTagged(join(dir, "missing"))).toEqual([]);
  });
});

describe("the forge's own tags", () => {
  let data: string;
  let app: App;
  let servers: Servers;
  const lines: { level: string; message: string; fields?: LogFields | undefined }[] = [];
  const log: Log = {
    debug: () => {},
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: () => {},
  };
  let work: string;
  const tag = (name: string, date: string, message?: string) =>
    Bun.spawn(["git", "tag", ...(message === undefined ? [] : ["-a", "-F", "-"]), name], {
      cwd: work,
      env: { ...env, GIT_COMMITTER_DATE: date },
      stdout: "ignore",
      stderr: "ignore",
      ...(message === undefined ? {} : { stdin: new Blob([message]) }),
    }).exited;
  // As a push lands them, without the forge's receive hooks (they need a running push session).
  const push = () =>
    Bun.spawn(["git", "fetch", "-q", work, "main:main", "+refs/tags/*:refs/tags/*"], {
      cwd: repoDir(app.reposRoot, "trevato", "forge"),
      env,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  const listed = async () =>
    ((await (await fetch(`${servers.url}/releases.json`)).json()) as { releases: { name: string }[] }).releases.map((r) => r.name);

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), "forge-own-tags-"));
    app = createApp({ dataDir: data, port: 0 });
    servers = await serve(app);
    const owner = await createUser(app.db, { origin: "seed", trusted: true, username: "trevato", email: "t@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!owner.ok) throw new Error(owner.error);
    const repo = await createRepo(app, owner.value, { name: "forge", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    work = join(data, "work");
    await Bun.$`mkdir -p ${work}`.quiet();
    await Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: work, env }).exited;
    await Bun.spawn(["git", "commit", "-q", "--allow-empty", "-m", "one"], { cwd: work, env }).exited;
  }, 60_000);
  afterAll(async () => {
    setTagged([]);
    servers.stop();
    app.close();
    await rm(data, { recursive: true, force: true });
  });

  test("are merged over the frozen list newest first, and /releases.json shows a tag pushed after boot at the next tick", async () => {
    const frozen = shippedReleases();
    await tag("v0.7.300", "2026-10-26T10:00:00Z");
    await tag("not-a-release", "2026-10-26T10:00:00Z", '{"version":"5.0.0","migrations":1}');
    await tag("v0.7.301", "2026-10-26T11:00:00Z", '{"version":"0.7.301","migrations":151}');
    await tag("v0.7.302", "2026-10-26T12:00:00Z", '{"version":"0.7.302","migrations":152}');
    expect(await push()).toBe(0);
    // The name is found whatever its case, as a URL finds it.
    const read = ownTagsReader({ db: app.db, reposRoot: app.reposRoot, log }, "Trevato/Forge");
    expect(await read()).toEqual({ version: "0.7.302", at: Date.parse("2026-10-26T12:00:00Z") });
    expect(shippedReleases().map((r) => r.version)).toEqual(["0.7.302", "0.7.301", ...frozen.map((r) => r.version)]);
    expect((await listed()).slice(0, 3)).toEqual(["0.7.302", "0.7.301", frozen[0]!.version]);

    await tag("v0.7.303", "2026-10-26T13:00:00Z", '{"version":"0.7.303","migrations":152}');
    expect(await push()).toBe(0);
    expect((await listed())[0]).toBe("0.7.302"); // until the tick
    await read();
    expect((await listed()).slice(0, 2)).toEqual(["0.7.303", "0.7.302"]);
    expect(lines.filter((l) => l.level === "info").map((l) => l.fields?.newest)).toEqual(["0.7.302", "0.7.303"]);
  });

  test("a FORGE_REPO that is no repository here is said once, and keeps what was read", async () => {
    const kept = shippedReleases();
    lines.length = 0;
    expect((await readOwnTags(app, "trevato-apps/forge")).ok).toBe(false);
    const read = ownTagsReader({ db: app.db, reposRoot: app.reposRoot, log }, "trevato-apps/forge");
    await expect(read()).rejects.toThrow("no repository on this forge");
    await expect(read()).rejects.toThrow();
    expect(lines).toEqual([
      {
        level: "warn",
        message: "release tags unread; /releases.json lists what was read before",
        fields: { why: "FORGE_REPO names trevato-apps/forge, which is no repository on this forge" },
      },
    ]);
    expect(shippedReleases()).toBe(kept);
  });
});
