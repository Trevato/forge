/**
 * The sync shapes between two real forges (#9560): a follower, a fork, a
 * mirror, both ways, several upstreams, a diamond; each walks the sync
 * contract in src/git/sync_link.ts over real HTTP and real git, and divergence
 * is shown with the one action that reconciles it. The same shapes run
 * in-process in test/sync-shapes.test.ts; here the two sides are two forges.
 * Public repositories, so the fetch needs no credential; pushes use the token.
 *
 * UNRUN: these cells have not yet run on a docker host. They run only when
 * asked for (`LAB_ONLY=shapes`), and the docs say so, until they have.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { LinkSync } from "../../src/git/sync_link.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ShapeDeps {
  /** Two forges and the owner's seed on each. */
  readonly a: { base: string; user: string; rw: string };
  readonly b: { base: string; user: string; rw: string };
  readonly api: (base: string, path: string, auth: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; data: Json; text: string }>;
  readonly git: (args: string[], env: NodeJS.ProcessEnv, cwd?: string) => string;
  readonly gitEnv: (user: string, token: string) => NodeJS.ProcessEnv;
  readonly cell: (pair: string, area: string, check: string, run: () => Promise<string | void>) => Promise<void>;
  readonly must: (ok: unknown, said: string) => void;
}

/**
 * The contract as the lab image carries it. The driver is mounted at /lab, apart
 * from the repository, so no relative path reaches src/ at run time; the image
 * built from the same ref has it at /app/src. The specifier is a variable so
 * the type-check in the repository does not look for /app, and the cast gives
 * the import the repository's own types.
 */
const SYNC_LINK: string = "/app/src/git/sync_link.ts";

export const runShapes = async (d: ShapeDeps): Promise<void> => {
  const { syncLink } = (await import(SYNC_LINK)) as typeof import("../../src/git/sync_link.ts");
  const pair = "shapes";
  const stamp = Date.now().toString(36);
  const dir = `/tmp/shapes-${stamp}`;
  mkdirSync(dir, { recursive: true });
  let n = 0;
  type Site = typeof d.a;
  /** A public repository on a forge, with one commit, and a working clone of it. */
  const make = async (site: Site, name: string): Promise<{ site: Site; url: string; work: string }> => {
    const made = await d.api(site.base, "/api/v1/repos", `Bearer ${site.rw}`, { method: "POST", body: { name, visibility: "public" } });
    d.must(made.status === 201 || made.status === 200, `create ${name}: ${made.status} ${made.text.slice(0, 100)}`);
    const work = `${dir}/${name}`;
    const env = d.gitEnv(site.user, site.rw);
    d.git(["init", "-q", "-b", "main", work], env);
    d.git(["remote", "add", "origin", `${site.base}/${site.user}/${name}.git`], env, work);
    return { site, url: `${site.base}/${site.user}/${name}.git`, work };
  };
  type Repo = Awaited<ReturnType<typeof make>>;
  const commit = (r: Repo, file: string, body: string): string => {
    const env = d.gitEnv(r.site.user, r.site.rw);
    writeFileSync(`${r.work}/${file}`, body);
    d.git(["add", "."], env, r.work);
    d.git(["commit", "-q", "-m", `${file}`], env, r.work);
    d.git(["push", "-q", "origin", "HEAD:refs/heads/main"], env, r.work);
    return d.git(["rev-parse", "HEAD"], env, r.work);
  };
  /** The repository's tip, read through the forge. */
  const tip = (r: Repo): string => d.git(["ls-remote", r.url, "refs/heads/main"], d.gitEnv(r.site.user, r.site.rw)).split(/\s/)[0]!;
  /** A repository on `site` that starts as a copy of `from` (the shape's fork, follower or mirror). */
  const copy = (site: Site, name: string, from: Repo): Promise<Repo> =>
    make(site, name).then((r) => {
      const env = d.gitEnv(site.user, site.rw);
      d.git(["fetch", "-q", from.url, "refs/heads/main"], env, r.work);
      d.git(["checkout", "-q", "-B", "main", "FETCH_HEAD"], env, r.work);
      d.git(["push", "-q", "origin", "HEAD:refs/heads/main"], env, r.work);
      return r;
    });
  /** The working clone at the forge's tip, so a sync starts from what the forge holds. */
  const refresh = (r: Repo): void => {
    const env = d.gitEnv(r.site.user, r.site.rw);
    d.git(["fetch", "-q", "origin", "refs/heads/main"], env, r.work);
    d.git(["checkout", "-q", "-B", "main", "FETCH_HEAD"], env, r.work);
  };
  /**
   * One sync of `me` from `from`: fetched into the working clone, moved when a
   * fast-forward, then pushed to the forge. Returns what the contract said.
   */
  const sync = async (me: Repo, from: Repo, stage = `refs/sync/${from.site.base.replace(/\W/g, "")}`): Promise<LinkSync> => {
    const env = d.gitEnv(me.site.user, me.site.rw);
    refresh(me);
    const result = await syncLink(me.work, "refs/heads/main", from.url, "refs/heads/main", stage);
    d.must(result.ok, `sync ${from.url} -> ${me.url}: ${result.ok ? "" : result.error}`);
    if (!result.ok) throw new Error("unreachable");
    if (result.value.moved) {
      d.git(["reset", "-q", "--hard", "refs/heads/main"], env, me.work);
      d.git(["push", "-q", "origin", "HEAD:refs/heads/main"], env, me.work);
    }
    return result.value;
  };
  const id = (): string => `${stamp}-${n++}`;

  await d.cell(pair, "follower", "a repository follows another across forges: taken once, then nothing", async () => {
    const up = await make(d.a, `up-${id()}`);
    commit(up, "a", "1\n");
    const me = await copy(d.b, `follow-${id()}`, up);
    const t = commit(up, "b", "2\n");
    const first = await sync(me, up);
    d.must(first.moved && first.to === t && first.judgement.action === "fast-forward", `first ${JSON.stringify(first.judgement)}`);
    const again = await sync(me, up);
    d.must(!again.moved && again.judgement.state === "synced" && tip(me) === t, "second sync was not a no-op");
    return first.judgement.words;
  });

  await d.cell(pair, "fork", "a fork of a fork follows down the chain", async () => {
    const root = await make(d.a, `root-${id()}`);
    commit(root, "a", "1\n");
    const org = await copy(d.b, `org-${id()}`, root);
    const person = await copy(d.a, `person-${id()}`, org);
    const t = commit(root, "b", "2\n");
    await sync(org, root);
    await sync(person, org);
    d.must(tip(person) === t, "the change did not reach the bottom");
  });

  await d.cell(pair, "mirror", "a mirror follows and never leads", async () => {
    const origin = await make(d.a, `origin-${id()}`);
    commit(origin, "a", "1\n");
    const mirror = await copy(d.b, `mirror-${id()}`, origin);
    for (let i = 0; i < 3; i++) commit(origin, `f${i}`, "x\n");
    const r = await sync(mirror, origin);
    d.must(r.judgement.behind === 3 && tip(mirror) === tip(origin), `mirror ${JSON.stringify(r.judgement)}`);
    const back = await sync(origin, mirror);
    d.must(!back.moved, "the mirror moved its origin");
  });

  await d.cell(pair, "both ways", "each side's work reaches the other and a loop is not made", async () => {
    const x = await make(d.a, `ping-${id()}`);
    commit(x, "base", "1\n");
    const y = await copy(d.b, `pong-${id()}`, x);
    const tx = commit(x, "fromA", "1\n");
    await sync(y, x);
    const ty = commit(y, "fromB", "1\n");
    await sync(x, y);
    d.must(tip(y) === ty && tip(x) === ty && tx !== ty, "the two did not converge");
    for (let i = 0; i < 3; i++) d.must(!(await sync(y, x)).moved && !(await sync(x, y)).moved, "a settled link moved");
  });

  await d.cell(pair, "divergence", "both sides see the same divergence and the one action that reconciles it", async () => {
    const x = await make(d.a, `div-${id()}`);
    commit(x, "base", "1\n");
    const y = await copy(d.b, `div-${id()}`, x);
    commit(x, "c", "A\n");
    commit(y, "c", "B\n");
    const fromY = await sync(y, x);
    const fromX = await sync(x, y);
    d.must(fromY.judgement.state === "diverged" && fromX.judgement.state === "diverged", "not seen as diverged");
    d.must(fromY.judgement.action === "keep-both" && fromX.judgement.action === "keep-both", "no reconciling action");
    d.must(!fromY.moved && !fromX.moved, "divergence moved a branch");
    d.must(fromY.judgement.conflicts.join() === "c", `conflicts ${fromY.judgement.conflicts}`);
    return fromY.judgement.words;
  });

  await d.cell(pair, "several upstreams", "two upstreams: the first lands, the second is reported with its action", async () => {
    const base = await make(d.a, `base-${id()}`);
    commit(base, "a", "1\n");
    const u1 = await copy(d.a, `u1-${id()}`, base);
    const u2 = await copy(d.b, `u2-${id()}`, base);
    const me = await copy(d.b, `multi-${id()}`, base);
    const t1 = commit(u1, "one", "1\n");
    commit(u2, "two", "2\n");
    d.must((await sync(me, u1, "refs/sync/u1")).to === t1, "first upstream not taken");
    const second = await sync(me, u2, "refs/sync/u2");
    d.must(!second.moved && second.judgement.action === "merge", `second ${JSON.stringify(second.judgement)}`);
    d.must(tip(me) === t1, "the diverged upstream moved the branch");
  });

  await d.cell(pair, "diamond", "the same change by two routes lands once", async () => {
    const top = await make(d.a, `top-${id()}`);
    commit(top, "a", "1\n");
    const left = await copy(d.a, `left-${id()}`, top);
    const right = await copy(d.b, `right-${id()}`, top);
    const bottom = await copy(d.b, `bottom-${id()}`, top);
    const t = commit(top, "b", "2\n");
    await sync(left, top);
    await sync(right, top);
    const viaLeft = await sync(bottom, left, "refs/sync/left");
    const viaRight = await sync(bottom, right, "refs/sync/right");
    d.must(viaLeft.moved && !viaRight.moved && viaRight.judgement.state === "synced", "landed twice or not at all");
    d.must(tip(bottom) === t, "bottom is not at the change");
  });

  await d.cell(pair, "resumable", "a sync cut off by a forge going away finishes on the next try", async () => {
    const up = await make(d.a, `cut-${id()}`);
    commit(up, "a", "1\n");
    const me = await copy(d.b, `cutme-${id()}`, up);
    const before = tip(me);
    const t = commit(up, "b", "2\n");
    refresh(me);
    const cut = await syncLink(me.work, "refs/heads/main", `${d.a.base}/${d.a.user}/does-not-exist.git`, "refs/heads/main", "refs/sync/cut");
    d.must(!cut.ok && tip(me) === before, "a failed sync moved the branch");
    d.must((await sync(me, up)).to === t, "the next try did not finish");
  });
};
