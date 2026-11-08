/**
 * The sync contract (src/git/sync_link.ts) walked through every shape a
 * network takes, with real git between real repositories: a follower, a
 * fork, a mirror, two forges syncing both ways, several upstreams, and a
 * diamond. Each shape is also a cell in scripts/forge-compat-lab.sh.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git/env.ts";
import { judgeLink, syncLink } from "../src/git/sync_link.ts";

let root = "";
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value.trim();
};
let n = 0;
/** A bare "forge" repository, optionally cloned from another. */
const forge = async (from?: string): Promise<string> => {
  const dir = join(root, `f${n++}.git`);
  if (from === undefined) {
    await git(root, "init", "-q", "--bare", "-b", "main", dir);
    return dir;
  }
  await git(root, "clone", "-q", "--bare", from, dir);
  return dir;
};
/** A commit on `dir`'s main, written through a throwaway clone. */
const commit = async (dir: string, file: string, body: string): Promise<string> => {
  const work = join(root, `w${n++}`);
  await git(root, "clone", "-q", dir, work).catch(async () => git(root, "init", "-q", "-b", "main", work));
  await git(work, "remote", "get-url", "origin").catch(() => git(work, "remote", "add", "origin", dir));
  await git(work, "checkout", "-q", "-B", "main").catch(() => undefined);
  await Bun.write(join(work, file), body);
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", `${file}: ${body.trim()}`);
  await git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(work, "rev-parse", "HEAD");
};
const tip = (dir: string): Promise<string> => git(dir, "rev-parse", "refs/heads/main");
const pull = (me: string, from: string, as = "refs/sync/up") => syncLink(me, "refs/heads/main", from, "refs/heads/main", as);
const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-sync-shapes-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("one link", () => {
  test("behind is taken in once; the second time nothing moves", async () => {
    const up = await forge();
    await commit(up, "a", "1\n");
    const me = await forge(up);
    const t2 = await commit(up, "b", "2\n");
    const first = value(await pull(me, up));
    expect(first).toMatchObject({ moved: true, to: t2 });
    expect(first.judgement.action).toBe("fast-forward");
    const again = value(await pull(me, up));
    expect(again).toMatchObject({ moved: false, from: t2, to: t2 });
    expect(again.judgement.state).toBe("synced");
    expect(await tip(me)).toBe(t2);
  });

  test("syncs at once into one stage ref take turns: one moves, the rest are no-ops, none fails", async () => {
    const up = await forge();
    await commit(up, "a", "1\n");
    const me = await forge(up);
    const t2 = await commit(up, "b", "2\n");
    const all = await Promise.all(Array.from({ length: 8 }, () => pull(me, up)));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(all.filter((r) => r.ok && r.value.moved)).toHaveLength(1);
    expect(await tip(me)).toBe(t2);
  });

  test("a sync cut off halfway leaves the branch and the next try finishes", async () => {
    const up = await forge();
    await commit(up, "a", "1\n");
    const me = await forge(up);
    const before = await tip(me);
    const t2 = await commit(up, "b", "2\n");
    const cut = await syncLink(me, "refs/heads/main", join(root, "gone.git"), "refs/heads/main", "refs/sync/up");
    expect(cut).toEqual({ ok: false, error: "unreachable" });
    expect(await tip(me)).toBe(before);
    expect(value(await pull(me, up)).to).toBe(t2);
  });

  test("a branch with work of its own is not overwritten", async () => {
    const up = await forge();
    await commit(up, "a", "1\n");
    const me = await forge(up);
    const old = await tip(me);
    await commit(up, "b", "2\n");
    const fresh = await commit(me, "mine", "x\n");
    const r = value(await pull(me, up));
    expect(r.moved).toBe(false);
    expect(r.judgement.state).toBe("diverged");
    expect(await tip(me)).toBe(fresh);
    expect(fresh).not.toBe(old);
  });

  test("ahead says to offer it; diverged says what to do and moves nothing", async () => {
    const up = await forge();
    await commit(up, "a", "1\n");
    const me = await forge(up);
    await commit(me, "mine", "1\n");
    const ahead = value(await pull(me, up));
    expect(ahead.judgement).toMatchObject({ state: "ahead", ahead: 1, action: "offer" });
    await commit(up, "theirs", "1\n");
    const clean = value(await pull(me, up)).judgement;
    expect(clean).toMatchObject({ state: "diverged", clean: true, action: "merge" });
    expect(clean.words).toContain("1 commit there, 1 commit here");
    await commit(up, "c", "up\n");
    await commit(me, "c", "me\n");
    const clash = value(await pull(me, up));
    expect(clash.moved).toBe(false);
    expect(clash.judgement).toMatchObject({ state: "diverged", clean: false, action: "keep-both", conflicts: ["c"] });
    expect(clash.judgement.words).toContain("c");
    // Theirs is staged so the one action has what it needs.
    expect(await git(me, "rev-parse", "refs/sync/up")).toBe(await tip(up));
  });

  test("an unborn branch is created from their tip", async () => {
    const up = await forge();
    const t = await commit(up, "a", "1\n");
    const me = await forge();
    const r = value(await pull(me, up));
    expect(r).toMatchObject({ moved: true, from: "", to: t });
    expect(await tip(me)).toBe(t);
    // Created once: the second sync finds it in step.
    expect(value(await pull(me, up)).moved).toBe(false);
  });

  test("a branch that moves under the sync is left as it is, and the sync says it raced", async () => {
    const up = await forge();
    await commit(up, "a", "1\n");
    const me = await forge(up);
    const before = await tip(me);
    await commit(up, "b", "2\n");
    // A held lock on our branch is another writer mid-update: the swap loses.
    await Bun.write(join(me, "refs/heads/main.lock"), "");
    const r = await pull(me, up);
    expect(r).toEqual({ ok: false, error: "raced" });
    await rm(join(me, "refs/heads/main.lock"));
    expect(await tip(me)).toBe(before);
    // The next try finishes.
    expect(value(await pull(me, up)).moved).toBe(true);
  });

  test("bad refs and sources are refused at the door", async () => {
    const me = await forge();
    expect(await syncLink(me, "refs/heads/main", "-evil", "refs/heads/main", "refs/sync/x")).toEqual({ ok: false, error: "bad-ref" });
    expect(await syncLink(me, "refs/heads/../x", "/x", "refs/heads/main", "refs/sync/x")).toEqual({ ok: false, error: "bad-ref" });
    expect((await judgeLink(me, "nope", "nope")).action).toBe("keep-both");
  });
});

describe("the shapes", () => {
  test("follower and fork: a chain keeps flowing down, once", async () => {
    const root0 = await forge();
    await commit(root0, "a", "1\n");
    const org = await forge(root0);
    const person = await forge(org);
    const t = await commit(root0, "b", "2\n");
    value(await pull(org, root0));
    value(await pull(person, org));
    expect(await tip(person)).toBe(t);
    expect(value(await pull(person, org)).moved).toBe(false);
  });

  test("mirror: a read-only copy follows and never leads", async () => {
    const origin = await forge();
    await commit(origin, "a", "1\n");
    const mirror = await forge(origin);
    for (let i = 0; i < 3; i++) await commit(origin, `f${i}`, "x\n");
    const r = value(await pull(mirror, origin));
    expect(r.judgement).toMatchObject({ state: "behind", behind: 3 });
    expect(await tip(mirror)).toBe(await tip(origin));
    expect(value(await pull(origin, mirror, "refs/sync/mirror")).moved).toBe(false);
  });

  test("both ways: each side's work reaches the other; a loop is not made", async () => {
    const a = await forge();
    await commit(a, "base", "1\n");
    const b = await forge(a);
    const ta = await commit(a, "fromA", "1\n");
    value(await pull(b, a, "refs/sync/a"));
    expect(await tip(b)).toBe(ta);
    const tb = await commit(b, "fromB", "1\n");
    value(await pull(a, b, "refs/sync/b"));
    expect(await tip(a)).toBe(tb);
    for (let i = 0; i < 3; i++) {
      expect(value(await pull(b, a, "refs/sync/a")).moved).toBe(false);
      expect(value(await pull(a, b, "refs/sync/b")).moved).toBe(false);
    }
    expect(await tip(a)).toBe(await tip(b));
  });

  test("both ways, at once: divergence is seen from both sides with the same action", async () => {
    const a = await forge();
    await commit(a, "base", "1\n");
    const b = await forge(a);
    await commit(a, "x", "a\n");
    await commit(b, "y", "b\n");
    const fromB = value(await pull(b, a, "refs/sync/a")).judgement;
    const fromA = value(await pull(a, b, "refs/sync/b")).judgement;
    expect(fromB).toMatchObject({ state: "diverged", action: "merge" });
    expect(fromA).toMatchObject({ state: "diverged", action: "merge" });
    expect(fromA.behind).toBe(fromB.ahead);
    expect(fromA.ahead).toBe(fromB.behind);
  });

  test("several upstreams: each is taken in turn, and the one that diverges is reported", async () => {
    const base = await forge();
    await commit(base, "a", "1\n");
    const u1 = await forge(base);
    const u2 = await forge(base);
    const me = await forge(base);
    const t1 = await commit(u1, "one", "1\n");
    await commit(u2, "two", "2\n");
    expect(value(await pull(me, u1, "refs/sync/u1")).to).toBe(t1);
    const second = value(await pull(me, u2, "refs/sync/u2"));
    expect(second.moved).toBe(false);
    expect(second.judgement).toMatchObject({ state: "diverged", action: "merge" });
    expect(await tip(me)).toBe(t1);
    // Each upstream keeps its own stage.
    expect(await git(me, "rev-parse", "refs/sync/u1")).toBe(t1);
    expect(await git(me, "rev-parse", "refs/sync/u2")).toBe(await tip(u2));
  });

  test("diamond: the same change by two routes lands once", async () => {
    const top = await forge();
    await commit(top, "a", "1\n");
    const left = await forge(top);
    const right = await forge(top);
    const bottom = await forge(top);
    const t = await commit(top, "b", "2\n");
    value(await pull(left, top));
    value(await pull(right, top));
    const viaLeft = value(await pull(bottom, left, "refs/sync/left"));
    const viaRight = value(await pull(bottom, right, "refs/sync/right"));
    expect(viaLeft.moved).toBe(true);
    expect(viaRight).toMatchObject({ moved: false });
    expect(viaRight.judgement.state).toBe("synced");
    expect(await tip(bottom)).toBe(t);
    expect(await git(bottom, "rev-list", "--count", "main")).toBe("2");
  });
});
