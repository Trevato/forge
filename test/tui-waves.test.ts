import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { listOpenPulls } from "../src/core/pulls.ts";
import { createSession } from "../src/core/sessions.ts";
import { refTip } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve } from "../src/http/server.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { getIssueById, setIssueState } from "../src/core/issues.ts";
import { writeWave, type Wave } from "../src/story/wave.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { waveLines, wavesScreen } from "../src/tui/screens/waves.ts";
import type { RepoSource } from "../src/view/source.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mergedPull, waveNaming } from "./helpers/wave-pulls.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const wave = (version: string, date: string, headline: string): Wave => ({
  version,
  date,
  headline,
  highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
  pulls: [{ title: "#1 A pull", url: "https://forge.example/o/r/pulls/1" }],
});
/** The same source, read live from another forge. */
const remoteOf = (src: RepoSource): RepoSource => ({
  ...src,
  where: {
    kind: "origin",
    origin: {
      id: "o1",
      userId: "u1",
      kind: "github",
      apiUrl: "https://api.github.test",
      webUrl: "https://github.test",
      login: "someone",
      createdAt: "2026-01-01T00:00:00Z",
      lastSyncAt: null,
      lastError: "",
      authKind: "pat",
      expiresAt: null,
      needsReauth: false,
      readOnly: false,
      software: "",
    },
    fullName: "someone/else",
    htmlUrl: "https://github.test/someone/else",
  },
});
const text = (w: Wave): string => {
  const r = writeWave(w);
  if (!r.ok) throw r.error;
  return r.value;
};

describe("waves in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let pub: Repo;
  let priv: Repo;
  let mix: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-waves-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "a@f.test", password: "a-long-passphrase" });
    const b = await signUp(forge, { username: "bob", email: "b@f.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    const p = await createRepo(forge, alice, { name: "pub", visibility: "public" });
    const q = await createRepo(forge, alice, { name: "priv", visibility: "private" });
    if (!p.ok || !q.ok) throw new Error("repo failed");
    const m = await createRepo(forge, alice, { name: "mix", visibility: "public" });
    if (!m.ok) throw new Error("repo failed");
    pub = p.value;
    priv = q.value;
    mix = m.value;
    const put = (repo: Repo, files: { path: string; content: string }[]) =>
      commitToBranch(forge, alice, repo, { message: "waves", files });
    await put(pub, [
      { path: "waves/0.9.0.md", content: text(wave("0.9.0", "2026-01-01", "Ninth")) },
      { path: "waves/0.10.0.md", content: text(wave("0.10.0", "2026-02-01", "Tenth")) },
      { path: "waves/broken.md", content: "no front matter\n" },
    ]);
    for (const r of [mix, priv])
      await commitToBranch(forge, alice, r, { message: "init", files: [{ path: "README.md", content: "hi\n" }] });
    const shown = await mergedPull(forge, alice, mix, "Shown work");
    const secret = await mergedPull(forge, alice, priv, "Secret work");
    await put(mix, [
      {
        path: "waves/0.1.0.md",
        content: waveNaming("0.1.0", [
          { owner: "alice", name: "mix", number: shown },
          { owner: "alice", name: "priv", number: secret },
        ]),
      },
    ]);
    await put(priv, [
      { path: "waves/1.0.0.md", content: text(wave("1.0.0", "2026-03-01", "Secret launch")) },
    ]);
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (
    user: User,
    repo: Repo,
    keys: string[] = [],
    remote = false,
  ): Promise<{ text: string; after: string[]; stop(): void }> => {
    const terminal = headlessTerminal(120, 40);
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    const here = local(session, repo);
    const src = remote ? remoteOf(here) : here;
    app.push(wavesScreen(session, app.ctx, src));
    await settleApp(app);
    const after: string[] = [];
    for (const k of keys) {
      terminal.feed(k === "enter" ? "\r" : k === "esc" ? "\x1b" : k);
      await settleApp(app);
      after.push(app.screen.toText());
    }
    return { text: app.screen.toText(), after, stop: () => app.stop() };
  };

  test("lists the web page's rows in the same order, bad files last", async () => {
    const h = await open(alice, pub);
    h.stop();
    const at = (s: string) => h.text.indexOf(s);
    expect(at("Tenth")).toBeGreaterThan(-1);
    expect(at("Tenth")).toBeLessThan(at("Ninth"));
    expect(at("Ninth")).toBeLessThan(at("broken.md"));
    expect(h.text).toContain("0.10.0");
  });

  test("a reader who cannot read the repository sees no waves", async () => {
    const h = await open(bob, priv);
    h.stop();
    expect(h.text).not.toContain("Secret launch");
    expect(h.text).toContain("No waves yet");
  });

  test("enter opens one wave: headline, version, date, highlights with why, pulls", async () => {
    const h = await open(alice, pub, ["enter"]);
    h.stop();
    expect(h.text).toContain("Tenth");
    expect(h.text).toContain("0.10.0  2026-02-01");
    expect(h.text).toContain("Thing 1 - because");
    expect(h.text).toContain("No pulls to show here.");
  });

  test("a wave's pulls are the page's: the owner sees the private one, an outsider does not", async () => {
    const owner = await open(alice, mix, ["enter"]);
    owner.stop();
    expect(owner.text).toContain("Shown work  merged 2026-03-04");
    expect(owner.text).toContain("/alice/mix/pulls/");
    expect(owner.text).toContain("Secret work");
    const outsider = await open(bob, mix, ["enter"]);
    outsider.stop();
    expect(outsider.text).toContain("Shown work");
    expect(outsider.text).not.toContain("Secret work");
    expect(outsider.text).not.toContain("/alice/priv/pulls/");
  });

  test("the wave leads to its pulls and back: pick, open the pull, back returns to the wave", async () => {
    const h = await open(alice, mix, ["enter", "n", "enter", "q"]);
    h.stop();
    const [wave, picked, pull, back] = h.after;
    expect(wave).toContain("> #");
    expect(picked).toContain("> #");
    // The second pull is the private one, picked by `n`; the pull screen names it.
    expect(picked).not.toEqual(wave);
    expect(pull).toContain("Secret work");
    expect(pull).not.toContain("Highlights");
    expect(back).toContain("Highlights");
    expect(back).toContain("Shown work");
  });

  test("the wave screen names the milestones it moved, as the page does, and not one the viewer may not see", async () => {
    const r = await createRepo(forge, alice, { name: "ms", visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    const repo = r.value;
    await commitToBranch(forge, alice, repo, { message: "init", files: [{ path: "README.md", content: "hi\n" }] });
    const issue = (title: string, sealed = false) => {
      const o = openIssue(forge, alice, repo, { title, sealed });
      if (!o.ok) throw new Error("issue failed");
      return o.value;
    };
    const goal = issue("Open goal");
    const hidden = issue("Hidden goal", true);
    const a = issue("Part A");
    const b = issue("Part B");
    for (const [up, down] of [[goal, a], [goal, b], [hidden, a]] as const)
      linkIssue(forge, alice, repo, getIssueById(forge.db, up.id)!, getIssueById(forge.db, down.id)!);
    setIssueState(forge.db, a.id, "closed", "done");
    const n = await mergedPull(forge, alice, repo, "Part A work");
    forge.db.query("UPDATE issue SET body = ? WHERE repo_id = ? AND number = ?").run(`Closes #${a.number}`, repo.id, n);
    await commitToBranch(forge, alice, repo, {
      message: "wave",
      files: [{ path: "waves/0.1.0.md", content: waveNaming("0.1.0", [{ owner: "alice", name: "ms", number: n }]) }],
    });
    const owner = await open(alice, repo, ["enter"]);
    owner.stop();
    expect(owner.text).toContain("Moved");
    expect(owner.text).toContain("Open goal - 1 of 2 done");
    // the progress line under the date, and the pull under the milestone it moved
    expect(owner.text).toContain("Open goal: 1 of 2 done");
    expect(owner.text).toMatch(/milestones\/\d+\n\s+#\d+ Part A work/);
    expect(owner.text).toContain(`/alice/ms/milestones/${goal.number}`);
    expect(owner.text).not.toContain("Hidden goal");
    const outsider = await open(bob, repo, ["enter"]);
    outsider.stop();
    expect(outsider.text).toContain("Open goal - 1 of 2 done");
    expect(outsider.text).not.toContain("Hidden goal");
  });

  test("enter on an unparsable row shows its reason", async () => {
    const h = await open(alice, pub, ["j", "j", "enter"]);
    h.stop();
    expect(h.text).toContain("broken.md");
    expect(h.text).toContain("Not a wave:");
  });

  test("wave text carries no escape or control characters", () => {
    const lines = waveLines(
      {
      ok: true,
      file: "1.0.0.md",
      wave: {
        version: "1.0.0",
        date: "2026-01-01",
        headline: "Hi\u001b[31m red\u0007\u202e",
        highlights: [{ title: "T\u001b]0;x\u0007", why: "w\nz" }],
        pulls: [],
      },
    },
    [{ owner: "o", name: "r", number: 1, title: "P\u001b[2J", mergedAt: null, state: "open" }],
    );
    expect(lines.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  });

  /** A fresh public repository with one merged pull and no waves. */
  const cuttable = async (name: string): Promise<Repo> => {
    const r = await createRepo(forge, alice, { name, visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice, r.value, { message: "init", files: [{ path: "README.md", content: "hi\n" }] });
    await mergedPull(forge, alice, r.value, "Cut this work");
    return r.value;
  };
  const pullCount = (repo: Repo): number =>
    forge.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM issue WHERE repo_id = ? AND kind = 'pull'").get(repo.id)!.n;
  const hasBranch = async (repo: Repo): Promise<boolean> =>
    (await refTip(repoDir(forge.reposRoot, repo.ownerName, repo.name), "refs/heads/wave/0.1.0")) !== undefined;

  test("c asks, y cuts a wave as a draft pull the web sees, and Enter opens it", async () => {
    const repo = await cuttable("cutme");
    const before = pullCount(repo);
    const ask = await open(alice, repo, ["c"]);
    ask.stop();
    expect(ask.text).toContain("1 pull since the last wave");
    expect(ask.text).toContain("cut wave 0.1.0? y/n");
    expect(pullCount(repo)).toBe(before);
    const opened = await open(alice, repo, ["c", "y", "enter"]);
    opened.stop();
    expect(opened.text).toContain("Wave 0.1.0");
    expect(pullCount(repo)).toBe(before + 1);
    const draft = listOpenPulls(forge.db, repo.id).find((p) => p.headBranch === "wave/0.1.0");
    expect(draft).toBeDefined();
    expect(draft!.state).toBe("open");
    expect(draft!.body).toContain("A draft of waves/0.1.0.md, listing 1 merged pull.");
    expect(await hasBranch(repo)).toBe(true);
    // The web sees the same pull, and the file it adds lists the merged one.
    const servers = await serve(forge);
    try {
      const cookie = `forge_session=${createSession(forge.db, alice.id).token}`;
      const page = await fetch(`${servers.url}/alice/cutme/pulls/${draft!.number}`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Wave 0.1.0");
    } finally {
      servers.stop();
    }
    const file = await Bun.$`git -C ${repoDir(forge.reposRoot, repo.ownerName, repo.name)} show wave/0.1.0:waves/0.1.0.md`.text();
    expect(file).toContain("Cut this work");
  });

  test("n and Esc write nothing, and y after moving to Cancel still cuts", async () => {
    const repo = await cuttable("cutno");
    const before = pullCount(repo);
    for (const keys of [["c", "n"], ["c", "esc"], ["c", "tab", "n"]]) {
      const h = await open(alice, repo, keys);
      h.stop();
      expect(pullCount(repo)).toBe(before);
      expect(await hasBranch(repo)).toBe(false);
    }
    const h = await open(alice, repo, ["c", "tab", "y"]);
    h.stop();
    expect(pullCount(repo)).toBe(before + 1);
    expect(await hasBranch(repo)).toBe(true);
  });

  test("nothing to cut, an unparsable wave, and a non-admin are refused with nothing written", async () => {
    const counts = [pub, mix].map(pullCount);
    const none = await open(alice, mix, ["c"]);
    none.stop();
    expect(none.text).toContain("Nothing has been merged since the last wave");
    const broken = await open(alice, pub, ["c"]);
    broken.stop();
    expect(broken.text).toContain("broken.md");
    expect(broken.text).not.toContain("cut wave");
    const viewer = await open(bob, mix, ["c", "y"]);
    viewer.stop();
    expect(viewer.text).toContain("Only a repository admin can cut a wave.");
    expect(viewer.text).not.toContain("cut wave");
    expect([pub, mix].map(pullCount)).toEqual(counts);
    expect(await hasBranch(mix)).toBe(false);
    expect(await hasBranch(pub)).toBe(false);
  });

  test("a live browse says waves are only read on this forge", async () => {
    const h = await open(alice, pub, [], true);
    h.stop();
    expect(h.text).toContain("only read on this forge");
    expect(h.text).not.toContain("no waves/ directory");
  });
});
