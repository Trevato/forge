/** The Files page's `diff` phase names its stretches, and a big diff is cheap on the second read (#6203). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addReview, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetDiffs } from "../src/git/diff-memory.ts";
import { clearDiffCache } from "../src/web/diff-cache.ts";
import { clearHeadReads } from "../src/web/head-reads.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let url = "";
const cells = process.env["FORGE_CELLS"];
const FILES = 20;
const LINES = 150;
const lineText = (f: number, i: number) => `export const v${f}_${i} = ${i} * ${f};`;

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-files-stretches-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const base = await commitToBranch(app, alice, repo.value, {
    message: "base", files: [{ path: "forge.json", content: "{}" }],
  });
  const big = await commitToBranch(app, alice, repo.value, {
    branch: "big",
    message: "big",
    files: Array.from({ length: FILES }, (_, f) => ({
      path: `src/m${f}.ts`,
      content: Array.from({ length: LINES }, (_, i) => lineText(f, i + 1)).join("\n") + "\n",
    })),
  });
  if (!base.ok || !big.ok) throw new Error("seed commits failed");
  const pull = await openPull(app, alice, repo.value, { title: "big", body: "", baseBranch: "main", headBranch: "big" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  url = `${servers.url}/alice/r/pulls/${pull.value.number}/files`;
  const review = await addReview(app, alice, repo.value, pull.value, {
    body: "anchor-survives-here", path: "src/m7.ts", line: 100, side: "new",
  });
  if (!review.ok) throw new Error(JSON.stringify(review.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const phase = (header: string, name: string) => {
  const m = header.match(new RegExp(`(?:^|, )${name};dur=([\\d.]+)`));
  return m ? Number(m[1]) : undefined;
};

test("a 3,000-line, 20-file diff names its stretches cold and draws under 30 ms warm, comments on their lines", async () => {
  // Cold means nothing remembered anywhere: the page's cache, and git's own
  // memory of the pair and its merge base, which opening the pull filled.
  clearDiffCache();
  forgetDiffs();
  clearHeadReads();
  const first = await fetch(url);
  await first.arrayBuffer();
  const cold = first.headers.get("server-timing") ?? "";
  for (const stretch of ["diff-git", "diff-parse", "diff-highlight"])
    expect(phase(cold, stretch)).toBeGreaterThanOrEqual(0);

  const second = await fetch(url);
  // Highlighting wraps tokens in spans; the rows read as text without them.
  const text = (await second.text()).replace(/<[^>]*>/g, "");
  const warm = second.headers.get("server-timing") ?? "";
  expect(warm).toContain('diff;dur=');
  expect(phase(warm, "diff")!).toBeLessThan(30);
  // A hit did no git, parsing or highlighting, so it names none.
  expect(phase(warm, "diff-git")).toBeUndefined();

  // The comment sits right after line 100 of m7.ts, and no other line's.
  const at = text.indexOf("anchor-survives-here");
  expect(at).toBeGreaterThan(0);
  const before = text.slice(0, at);
  expect(before.lastIndexOf("v7_100 =")).toBeGreaterThan(before.lastIndexOf("v7_99 ="));
  expect(before.lastIndexOf("v7_100 =")).toBeGreaterThan(before.lastIndexOf("v19_150 ="));
  expect(text.indexOf("v7_101 =")).toBeGreaterThan(at);
});
