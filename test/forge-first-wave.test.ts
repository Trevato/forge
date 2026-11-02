/** The forge's own story: the committed `waves/` parse, carry no `TODO` placeholder and stay short enough to read (#7764). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { PLACEHOLDER } from "../src/story/cut.ts";
import { readWaves } from "../src/story/waves.ts";

/** A wave is read, not archived: a curated list, well under the reader's 256 KB bound. */
const MAX_PULLS = 150;
const MAX_WAVE_BYTES = 64 * 1024;

const WAVES = join(import.meta.dir, "..", "waves");

let dataDir = "";
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-first-wave-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("the committed waves read through readWaves, each whole, none a draft", async () => {
  const names = (await readdir(WAVES)).filter((n) => n.endsWith(".md"));
  expect(names.length).toBeGreaterThanOrEqual(1);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@f.dev",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error("user");
  const r = await createRepo(app, u.value, { name: "forge", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  const files = await Promise.all(
    names.map(async (n) => ({
      path: `waves/${n}`,
      content: await Bun.file(join(WAVES, n)).text(),
    })),
  );
  const c = await commitToBranch(app, u.value, r.value, { message: "waves", files });
  if (!c.ok) throw new Error("commit");
  const entries = await readWaves(
    repoDir(app.reposRoot, r.value.ownerName, r.value.name),
    r.value.defaultBranch,
  );
  expect(entries.length).toBe(names.length);
  for (const e of entries) {
    if (!e.ok) throw new Error(e.reason);
    const text = await Bun.file(join(WAVES, e.file)).text();
    expect(text).not.toContain(PLACEHOLDER);
    expect(e.wave.highlights.length).toBeGreaterThanOrEqual(3);
    expect(e.wave.pulls.length).toBeGreaterThan(0);
    expect(e.wave.pulls.length).toBeLessThanOrEqual(MAX_PULLS);
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_WAVE_BYTES);
    // Each highlight rests on a pull the wave lists.
    const listed = new Set(e.wave.pulls.map((p) => /^#(\d+) /.exec(p.title)?.[1]));
    for (const h of e.wave.highlights) {
      const cited = [...h.why.matchAll(/#(\d+)/g)].map((m) => m[1]);
      expect(cited.length).toBeGreaterThan(0);
      for (const n of cited) expect(listed.has(n)).toBe(true);
    }
  }
});
