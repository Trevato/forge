/**
 * Attaching a look names its width and its place (#1066): `phone` or
 * `desktop` only, and only to a repository that is an app. Each refusal
 * leaves nothing stored — no row, no file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLook } from "../src/actions/attach_look.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import { looksForEnv } from "../src/core/looks.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { encodePng } from "../src/design/image/png.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const IMAGE = Buffer.from(encodePng(2, 2, new Uint8Array(16).fill(200))).toString("base64");

describe("attachLook width and place", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  let pull: Pull;
  let plainRepo: Repo;
  let plainPull: Pull;

  const attach = (width: unknown, target: [Repo, Pull] = [repo, pull]) =>
    attachLook(app, alice, target[0], target[1], {
      width: width as string,
      note: "the garden",
      image: IMAGE,
    });
  const kept = () => looksForEnv(app.db, record.id, previewEnv(pull.number));
  const onDisk = () => {
    const dir = join(dataDir, "looks");
    return existsSync(dir) ? readdirSync(dir, { recursive: true }) : [];
  };
  const rowCount = () =>
    (app.db.query("SELECT COUNT(*) AS n FROM look").get() as { n: number }).n;

  async function pullFor(name: string): Promise<[Repo, Pull]> {
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    await commitToBranch(app, alice, made.value, {
      branch: "one",
      base: "main",
      message: "one",
      files: [{ path: "one.md", content: "x\n" }],
    });
    const opened = await openPull(app, alice, made.value, {
      title: "Change one",
      body: "",
      baseBranch: "main",
      headBranch: "one",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return [made.value, opened.value];
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-attach-refusals-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    [repo, pull] = await pullFor("garden");
    const inserted = insertApp(app.db, { repoId: repo.id, slug: "garden", access: "public" });
    if (!inserted.ok) throw new Error(inserted.error);
    record = inserted.value;
    [plainRepo, plainPull] = await pullFor("plain");
  });

  afterAll(async () => {
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a phone look and a desktop look are both kept", () => {
    const phone = attach("phone");
    const desktop = attach("desktop");
    expect(phone.ok && phone.value.kind).toBe("phone");
    expect(desktop.ok && desktop.value.kind).toBe("desktop");
    expect(kept().map((l) => l.kind).sort()).toEqual(["desktop", "phone"]);
    expect(onDisk().filter((f) => /\.png$/.test(String(f))).length).toBe(2);
  });

  test("tablet, an empty string and a number are bad_width, and nothing is stored", () => {
    const rows = rowCount();
    const files = onDisk().length;
    for (const width of ["tablet", "", 390]) {
      const r = attach(width);
      expect(r).toEqual({ ok: false, error: "bad_width" } as never);
      expect(rowCount()).toBe(rows);
      expect(onDisk().length).toBe(files);
    }
  });

  test("a repository that is not an app is no_app, and nothing is stored", () => {
    const rows = rowCount();
    const files = onDisk().length;
    const r = attach("phone", [plainRepo, plainPull]);
    expect(r).toEqual({ ok: false, error: "no_app" } as never);
    expect(rowCount()).toBe(rows);
    expect(onDisk().length).toBe(files);
  });
});
