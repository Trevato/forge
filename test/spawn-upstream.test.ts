/**
 * Looking upstream (#2631): two local bare repositories, parent and child,
 * and no network. The child is behind by what the parent gained; an
 * unreachable upstream is a recorded error, never a throw.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { checkUpstream, upstreamRemote, upstreamState, upstreamWords } from "../src/spawn/upstream.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value;
};

describe("looking upstream", () => {
  let dir = "";
  let app: App;
  let parent = "";
  let work = "";
  let child = "";

  const commit = async (n: number) => {
    await Bun.write(join(work, `f${n}.txt`), String(n));
    await git(work, "add", ".");
    await git(work, "commit", "-m", `c${n}`);
    await git(work, "push", "-q", parent, "HEAD:refs/heads/main");
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-upstream-"));
    app = createApp({ dataDir: join(dir, "data"), url: "https://child.test", port: 0 });
    parent = join(dir, "parent.git");
    work = join(dir, "work");
    await git(dir, "init", "-q", "--bare", "-b", "main", parent);
    await git(dir, "init", "-q", "-b", "main", work);
    await commit(0);
    child = repoDir(app.reposRoot, "kid", "forge");
    await mkdir(join(app.reposRoot, "kid"), { recursive: true });
    await git(dir, "clone", "-q", "--bare", parent, child);
    await Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "https://parent.test",
        forgeCode: { repo: "kid/forge", upstream: "root/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
      }),
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("the remote is the parent's origin and repository", async () => {
    expect(await upstreamRemote(app)).toBe("https://parent.test/root/forge.git");
  });

  test("up to date, then behind by what the parent gained", async () => {
    const first = await checkUpstream(app, { remote: parent, now: 1000 });
    expect(first).toMatchObject({ behind: 0, error: "", checkedAt: 1000 });
    for (const n of [1, 2, 3]) await commit(n);
    const next = await checkUpstream(app, { remote: parent, now: 2000 });
    expect(next?.behind).toBe(3);
    expect(next?.parentTip).toMatch(/^[0-9a-f]{40}$/);
    expect(await upstreamState(app)).toEqual(next);
    expect(await git(child, "rev-parse", "refs/upstream/main")).toBe(next!.parentTip);
  });

  test("an unreachable upstream keeps its error and what was known", async () => {
    const s = await checkUpstream(app, { remote: join(dir, "nowhere.git"), now: 3000 });
    expect(s?.error).not.toBe("");
    expect(s?.behind).toBe(3);
    expect((await upstreamState(app))?.error).toBe(s!.error);
  });

  test("words", () => {
    const base = { behind: 3, parentTip: "", checkedAt: 0, error: "" };
    const at = 12 * 60_000;
    expect(upstreamWords({ ...base }, at)).toBe("your parent has 3 new commits (checked 12 min ago)");
    expect(upstreamWords({ ...base, behind: 0 }, at)).toBe("up to date (checked 12 min ago)");
    expect(upstreamWords({ ...base, error: "boom" }, at)).toBe("could not check your parent: boom (12 min ago)");
  });

  test("a severed forge is not checked", async () => {
    const doc = await Bun.file(join(app.config.dataDir, "parent.json")).json();
    doc.forgeCode.severedAt = new Date().toISOString();
    await Bun.write(join(app.config.dataDir, "parent.json"), JSON.stringify(doc));
    expect(await checkUpstream(app, { remote: parent })).toBeUndefined();
  });
});
