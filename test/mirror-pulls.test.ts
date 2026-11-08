/**
 * A pull opened on the read-only Forgejo mirror becomes a pull here (#9011):
 * its title, its author's name and a link back; a guest unless the author is
 * a trusted source; one pull however often the event and the sweep fire; a
 * head that moves there moves here. The mirror gets one comment and its
 * webhook, never a push. Against the fake Forgejo; the git fetch is the one
 * seam, standing in for `refs/pull/<n>/head`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssue } from "../src/core/issues.ts";
import { setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { createOrigin } from "../src/core/origins.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { trustSource, untrust } from "../src/core/trusted_sources.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { approveGuest, guestWaits } from "../src/origins/guest.ts";
import { hookSecret, receiveOriginHook, signatureOf } from "../src/origins/hook.ts";
import { bringMirrorPulls, broughtFrom, receiveMirrorHook, watchMirror, type FetchHead } from "../src/origins/mirror-pulls.ts";
import { ForgejoProvider } from "../src/origins/providers/forgejo.ts";
import { staticCredential } from "../src/origins/types.ts";
import { newFakeState, serveFakeForge, type FakeForge, type FakeState } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "tok-mirror-1234";

describe("pulls opened on the mirror come here", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let fake: FakeForge;
  let state: FakeState;
  let fetches = 0;

  // The mirror's `refs/pull/<n>/head`: a commit on the branch the pull rides
  // here, a new one only when the mirror's head sha moved.
  const served = new Map<number, string>();
  const fetchHead: FetchHead = async (a, r, _t, _p, number, ref) => {
    const dir = repoDir(a.reposRoot, r.ownerName, r.name);
    const sha = state.issues.get("trevato-apps/forge")?.find((i) => i.number === number)?.pull?.headSha ?? "";
    if (served.get(number) === sha) return resolveOid(dir, ref);
    served.set(number, sha);
    fetches++;
    const branch = ref.replace(/^refs\/heads\//, "");
    const made = await commitToBranch(a, alice, r, {
      branch,
      message: `Mirror pull ${number}, fetch ${fetches}`,
      files: [{ path: `m${number}-${fetches}.md`, content: "from the mirror\n" }],
    });
    if (!made.ok) return undefined;
    return resolveOid(dir, ref);
  };
  const provider = () =>
    new ForgejoProvider(
      staticCredential({ kind: "forgejo", apiUrl: fake.apiUrl, webUrl: fake.url, token: TOKEN }),
    );
  const bring = () => bringMirrorPulls(app, repo, { provider: provider(), fetchHead });
  const openOnMirror = (number: number, user: string, headSha = `${number}`.padStart(40, "a")) => {
    const all = state.issues.get("trevato-apps/forge") ?? [];
    all.push({
      id: 500 + number,
      number,
      title: `Fix ${number}`,
      body: "It was broken.",
      user,
      pull: { base: "main", head: `fix-${number}`, headRepo: `${user}/forge`, headSha },
    });
    state.issues.set("trevato-apps/forge", all);
  };
  const broughtCount = () =>
    app.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'pull' AND origin_html_url IS NOT NULL",
      )
      .get(repo.id)!.n;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mirror-pulls-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.test" });
    state = newFakeState("forgejo", "trevato", TOKEN);
    state.repos.push({ id: 1, fullName: "trevato-apps/forge", cloneUrl: "http://127.0.0.1/none.git", admin: true });
    fake = serveFakeForge(state);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "forge\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const origin = createOrigin(app.db, dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: fake.apiUrl,
      webUrl: fake.url,
      login: "trevato",
      token: TOKEN,
    });
    if (!origin.ok) throw new Error(origin.error);
    setMirrorTarget(app.db, {
      repoId: repo.id,
      originId: origin.value.id,
      fullName: "trevato-apps/forge",
      cloneUrl: `${fake.url}/trevato-apps/forge.git`,
      tips: {},
    });
  }, 60_000);

  afterAll(async () => {
    fake.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a mirror pull becomes a guest pull with its author and a link back, and the mirror is told where", async () => {
    openOnMirror(1, "tdobbertin-espo");
    // Whatever starts a check or a preview hears `pull.opened`: by then the
    // pull must already be a guest, or it could start with secrets.
    const seen: Array<string | null> = [];
    const stop = app.bus.subscribe((event) => {
      if (event.kind !== "pull.opened" || event.repoId !== repo.id) return;
      const number = (event.payload as { number: number }).number;
      const issue = getIssue(app.db, repo.id, number)!;
      seen.push(issue.originAuthor);
      expect(guestWaits(app.db, getPull(app.db, repo.id, number)!)).toBe(true);
    });
    const report = await bring();
    stop();
    expect(seen).toEqual(["tdobbertin-espo"]);
    expect(report.error).toBe("");
    expect(report.opened.length).toBe(1);
    const pull = getPull(app.db, repo.id, report.opened[0]!)!;
    expect(pull.title).toBe("Fix 1");
    expect(pull.headBranch).toBe("mirror-pull/1");
    expect(pull.baseBranch).toBe("main");
    const issue = getIssue(app.db, repo.id, pull.number)!;
    expect(issue.originAuthor).toBe("tdobbertin-espo");
    expect(issue.originUrl).toBe(`${fake.url}/1`);
    expect(issue.body).toContain(`From @tdobbertin-espo on ${fake.url}/1`);
    expect(guestWaits(app.db, pull)).toBe(true);

    const said = state.comments.get("trevato-apps/forge") ?? [];
    expect(said.length).toBe(1);
    expect(said[0]!.issueNumber).toBe(1);
    expect(said[0]!.body).toContain(`https://forge.test/alice/forge/pulls/${pull.number}`);
    // The only write the mirror saw is that comment.
    const writes = state.requests.filter((q) => q.method !== "GET");
    expect(writes.map((q) => `${q.method} ${q.path}`)).toEqual([
      "POST /api/v1/repos/trevato-apps/forge/issues/1/comments",
    ]);
  });

  test("the event and the sweep firing together still make one pull", async () => {
    openOnMirror(2, "someone");
    const before = broughtCount();
    const [a, b] = await Promise.all([bring(), bring()]);
    expect(a.opened.length + b.opened.length).toBe(1);
    expect(broughtCount()).toBe(before + 1);
    await bring();
    expect(broughtCount()).toBe(before + 1);
    expect((state.comments.get("trevato-apps/forge") ?? []).filter((c) => c.issueNumber === 2).length).toBe(1);
  });

  test("a trusted source's mirror pull does not wait as a guest", async () => {
    const host = new URL(fake.url).host;
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const trusted = trustSource(app.db, { host, account: "friend", until, setBy: alice.id });
    expect(typeof trusted).toBe("object");
    openOnMirror(3, "friend");
    const report = await bring();
    const pull = getPull(app.db, repo.id, report.opened[0]!)!;
    expect(getIssue(app.db, repo.id, pull.number)!.originAuthor).toBe("friend");
    expect(guestWaits(app.db, pull)).toBe(false);

    // Trust that lapses (or is taken back) makes it wait again.
    app.db
      .query("UPDATE trusted_source SET until = ?1 WHERE host = ?2 AND account = 'friend'")
      .run(new Date(Date.now() - 60_000).toISOString(), host);
    expect(guestWaits(app.db, pull)).toBe(true);
    const renewed = trustSource(app.db, { host, account: "friend", until, setBy: alice.id });
    expect(guestWaits(app.db, pull)).toBe(false);
    if (typeof renewed === "object") untrust(app.db, renewed.id);
    expect(guestWaits(app.db, pull)).toBe(true);
  });

  test("an untrusted guest still waits while someone else is trusted", async () => {
    const pull = getPull(app.db, repo.id, broughtFrom(app, repo.id, `${fake.url}/1`)!)!;
    expect(guestWaits(app.db, pull)).toBe(true);
  });

  test("a head that moves on the mirror moves the pull here", async () => {
    const mirror = state.issues.get("trevato-apps/forge")!.find((i) => i.number === 1)!;
    const number = app.db
      .query<{ number: number }, [string]>("SELECT number FROM issue WHERE origin_html_url = ?1")
      .get(`${fake.url}/1`)!.number;
    const approved = getPull(app.db, repo.id, number)!;
    const was = approved.headOid;
    expect(approveGuest(app.db, repo, approved, alice).ok).toBe(true);
    expect(guestWaits(app.db, approved)).toBe(false);
    mirror.pull = { ...mirror.pull!, headSha: "b".repeat(40) };
    const report = await bring();
    expect(report.moved).toEqual([number]);
    const now = getPull(app.db, repo.id, number)!;
    // The head a person approved is not the one that would run now.
    expect(guestWaits(app.db, now)).toBe(true);
    expect(now.headOid).not.toBe(was);
    expect(await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), `refs/pull/${number}/head`)).toBe(
      now.headOid,
    );
  });

  test("the mirror's webhook is set once, and its signed delivery is believed", async () => {
    await watchMirror(app, repo, provider());
    await watchMirror(app, repo, provider());
    const hooks = state.hooks.get("trevato-apps/forge") ?? [];
    expect(hooks.length).toBe(1);
    const config = hooks[0]!["config"] as Record<string, string>;
    expect(config["url"]).toBe("https://forge.test/api/v1/repos/alice/forge/origin-hook");
    expect(config["secret"]).toBe(hookSecret(app, repo));

    const raw = JSON.stringify({ action: "opened", number: 9 });
    const mac = createHmac("sha256", hookSecret(app, repo)).update(raw).digest("hex");
    const good = signatureOf(new Headers({ "x-forgejo-signature": mac }));
    expect(good).toBe(`sha256=${mac}`);
    // Not an origin's delivery: this repository mirrors nothing.
    expect(await receiveOriginHook(app, repo, raw, good)).toBe(false);
    const bad = signatureOf(new Headers({ "x-forgejo-signature": "0".repeat(64) }));
    expect(await receiveMirrorHook(app, repo, raw, bad, { provider: provider(), fetchHead })).toBe(false);
    expect(await receiveMirrorHook(app, repo, raw, null, { provider: provider(), fetchHead })).toBe(false);
    expect(signatureOf(new Headers({ "x-forgejo-signature": "not hex" }))).toBeNull();

    // A signed delivery brings the pull it announced.
    openOnMirror(9, "hooked");
    const before = broughtCount();
    expect(await receiveMirrorHook(app, repo, raw, good, { provider: provider(), fetchHead })).toBe(true);
    // Runs on one repository queue: this one waits for the delivery's, and finds nothing left.
    const after = await bring();
    expect(after.opened).toEqual([]);
    expect(broughtCount()).toBe(before + 1);
    expect(getIssue(app.db, repo.id, broughtFrom(app, repo.id, `${fake.url}/9`)!)!.originAuthor).toBe("hooked");
  });
});
