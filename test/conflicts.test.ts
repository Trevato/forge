import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { applyChoices, parseConflicts } from "../src/git/conflicts.ts";
import { choicesFrom } from "../src/web/pages/conflicts.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

const labels = { ours: "main", theirs: "loud" };
const FILE =
  "top\n<<<<<<< a\none\n||||||| b\nzero\n=======\nuno\n>>>>>>> c\nmid\n" +
  "<<<<<<< a\ntwo\n=======\ndos\n>>>>>>> c\nend\n";

describe("conflict blocks", () => {
  test("a two-block conflict resolved by both gives the file", () => {
    const parsed = parseConflicts(FILE);
    expect(parsed.blocks).toEqual([
      { base: "zero\n", ours: "one\n", theirs: "uno\n" },
      { base: "", ours: "two\n", theirs: "dos\n" },
    ]);
    const both = { kind: "both" } as const;
    expect(applyChoices(parsed, [both, both], labels)).toBe(
      "top\none\nuno\nmid\ntwo\ndos\nend\n",
    );
  });

  test("ours, theirs and your own text are kept verbatim", () => {
    const parsed = parseConflicts(FILE);
    const mine = "  keep\tme  \n\nexactly\n";
    expect(
      applyChoices(
        parsed,
        [{ kind: "text", text: mine }, { kind: "theirs" }],
        labels,
      ),
    ).toBe(`top\n${mine}mid\ndos\nend\n`);
    expect(
      applyChoices(parsed, [{ kind: "ours" }, { kind: "text", text: "" }], labels),
    ).toBe("top\none\nmid\nend\n");
  });

  test("an open block shows markers named by branch; an unclosed one is kept", () => {
    const out = applyChoices(parseConflicts(FILE), [undefined, { kind: "ours" }], labels);
    expect(out).toContain("<<<<<<< main\none\n=======\nuno\n>>>>>>> loud\n");
    const broken = "a\n<<<<<<< x\nb\n";
    expect(applyChoices(parseConflicts(broken), [], labels)).toBe(broken);
  });

  test("the query becomes choices; box text ends in a newline", () => {
    const q = new URLSearchParams("b0=both&b1=text&t1=hi%0D%0Athere&b2=nope");
    expect(choicesFrom(q, 3)).toEqual([
      { kind: "both" },
      { kind: "text", text: "hi\nthere\n" },
      undefined,
    ]);
    // Words with no tap picked are the person's own text.
    expect(choicesFrom(new URLSearchParams("t0=typed&b1=ours&t1=&t2="), 3)).toEqual([
      { kind: "text", text: "typed\n" },
      { kind: "ours" },
      undefined,
    ]);
  });
});

describe("the Resolve page", () => {
  const gitEnv = gitClientEnv();
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let dir: string;
  let headers: Record<string, string>;

  async function git(args: string[]): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      env: gitEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  }
  const commit = async (text: string, message: string) => {
    await Bun.write(join(dir, "code.txt"), text);
    await git(["commit", "-am", message]);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cf-"));
    work = await mkdtemp(join(tmpdir(), "forge-cf-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "dev",
      email: "dev@f.dev",
      password: "conflicts-pass-123",
    });
    const token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "dev",
        password: "conflicts-pass-123",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    dir = work;
    await git(["clone", `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`, "app"]);
    dir = join(work, "app");
    const lines = (a: string, b: string) => `x\n${a}\nm1\nm2\nm3\nm4\nm5\nm6\n${b}\ny\n`;
    await Bun.write(join(dir, "code.txt"), lines("a", "b"));
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await git(["push", "origin", "main"]);
    await git(["checkout", "-b", "loud"]);
    await commit(lines("A-loud", "B-loud"), "loud");
    await git(["push", "origin", "loud"]);
    await fetch(`${base}/api/v1/repos/dev/app/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base: "main", head: "loud", title: "Loud" }),
    });
    await git(["checkout", "main"]);
    await commit(lines("A-main", "B-main"), "main");
    await git(["push", "origin", "main"]);
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("shows the count and the merged file for the chosen blocks", async () => {
    const url = `${base}/dev/app/pulls/1/resolve`;
    const none = await (await fetch(url, { headers })).text();
    expect(none).toContain("0 of 2 resolved");
    expect(none).toContain("&lt;&lt;&lt;&lt;&lt;&lt;&lt; main");

    const res = await fetch(`${url}?file=code.txt&b0=both&b1=text&t1=mine%0A`, { headers });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("2 of 2 resolved");
    expect(page).toContain("A-main\nA-loud\n");
    expect(page).toContain("m6\nmine\ny\n");
  });

  test("conflict blocks are headings over rows, not boxed cards", async () => {
    const page = await (await fetch(`${base}/dev/app/pulls/1/resolve`, { headers })).text();
    expect(page).toMatch(/<div\s+class="card bare rs-card"/);
    expect(page).not.toMatch(/<div\s+class="card rs-card"/);
    expect(page).toContain("<h2>Block 1 of 2</h2>");
    expect(page).toContain('name="b0"');
  });

  test("the sides are rows on the page background, and the words are plain", async () => {
    const page = await (await fetch(`${base}/dev/app/pulls/1/resolve`, { headers })).text();
    // Sides: a muted label over the text, no box, a hairline where it ends.
    const rule = /\.rs-side pre, \.rs-merged \{([^}]*)\}/.exec(page)![1]!;
    expect(rule).toContain("background: none");
    expect(rule).toContain("border-radius: 0");
    expect(rule).toContain("border-bottom: 1px solid");
    expect(rule).not.toMatch(/background:\s*var/);
    expect(page).toMatch(/<span class="rs-label small mono">main<\/span>\s*<pre>/);
    expect(page).not.toMatch(/<strong class="small mono">main<\/strong>/);
    // Only the radio taps keep a border.
    expect(/\.rs-taps label \{[^}]*border: 1px solid/.test(page)).toBe(true);
    // Plain taps and help text.
    for (const w of ["Keep main", "Keep loud", "Keep both", "Write my own", "Show the result", "Save to loud", "nothing is saved until you finish"])
      expect(page).toContain(w);
    for (const w of [">Ours<", ">Theirs<", ">Mine<", "Before either changed", "Update the merged file", "Finish: commit"])
      expect(page).not.toContain(w);
  });

  test("the empty states and the crew card are bare, in plain words", async () => {
    const none = await (await fetch(`${base}/dev/app/pulls/1/resolve?file=nope.txt`, { headers })).text();
    expect(none).toMatch(/<div\s+class="card bare"/);
    expect(none).not.toMatch(/<div\s+class="card"/);
    expect(none).toContain("No conflict in that file.");
    expect(none).not.toContain("Nothing to resolve");
  });

  test("readers and strangers do not get it; an unnamed file is not read", async () => {
    const url = `${base}/dev/app/pulls/1/resolve`;
    expect((await fetch(url)).status).toBe(404);
    const odd = await (await fetch(`${url}?file=../../etc/passwd`, { headers })).text();
    expect(odd).toContain("No conflict in that file.");
    expect(odd).not.toContain("This pull has no conflicts.");
  });

  test("the merge box offers Resolve to a writer", async () => {
    const files = await (await fetch(`${base}/dev/app/pulls/1/files`, { headers })).text();
    expect(files).toContain('href="/dev/app/pulls/1/resolve"');
  });

  const tipOf = async (branch: string): Promise<string> => {
    const out = await runGit(["rev-parse", `refs/heads/${branch}`], {
      cwd: repoDir(app.reposRoot, "dev", "app"),
    });
    return out.ok ? out.value.trim() : "";
  };
  const drawnFields = async (n: number, file: string) => {
    const drawn = await (
      await fetch(`${base}/dev/app/pulls/${n}/resolve?file=${file}`, { headers })
    ).text();
    const oid = (name: string) =>
      new RegExp(`name="${name}" value="([0-9a-f]{40})"`).exec(drawn)![1]!;
    return { file, head: oid("head"), base: oid("base") };
  };
  const finishPost = (n: number, auth: Record<string, string>, origin: string | null, body: Record<string, string>) =>
    fetch(`${base}/dev/app/pulls/${n}/resolve`, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/x-www-form-urlencoded",
        ...(origin === null ? {} : { origin }),
      },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  test("Finish refuses a reader, a stranger, a read token and a foreign origin, and writes nothing", async () => {
    const form = { ...(await drawnFields(1, "code.txt")), b0: "both", b1: "ours" };
    const tip = await tipOf("loud");
    const mint = async (user: string, scope: string) => {
      await fetch(`${base}/signup`, {
        method: "POST",
        body: new URLSearchParams({ username: user, email: `${user}@f.dev`, password: "conflicts-pass-123" }),
        redirect: "manual",
      });
      const j = (await (
        await fetch(`${base}/api/v1/tokens`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adminConfirm: true, username: user, password: "conflicts-pass-123", name: "t", scope }),
        })
      ).json()) as { token: string };
      return { authorization: `Bearer ${j.token}` };
    };
    const reader = await mint("eve", "rw");
    const attempts: [string, Response][] = [
      ["reader", await finishPost(1, reader, base, form)],
      ["stranger", await finishPost(1, {}, base, form)],
      ["read token", await finishPost(1, await mint("dev2", "ro"), base, form)],
      ["foreign origin", await finishPost(1, { authorization: headers["authorization"]! }, "http://evil.example", form)],
    ];
    for (const [who, res] of attempts) {
      expect([who, [403, 404].includes(res.status)]).toEqual([who, true]);
    }
    // dev's own read-scoped token is the real case: same user, wrong scope.
    const devRo = await (
      await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true, username: "dev", password: "conflicts-pass-123", name: "ro", scope: "ro" }),
      })
    ).json() as { token: string };
    const ro = await finishPost(1, { authorization: `Bearer ${devRo.token}` }, base, form);
    expect(ro.status).toBe(403);
    expect(await tipOf("loud")).toBe(tip);
  });

  test("Finish refuses a pull with two conflicted files and writes nothing", async () => {
    await git(["checkout", "main"]);
    await Bun.write(join(dir, "a.txt"), "a\n");
    await Bun.write(join(dir, "b.txt"), "b\n");
    await git(["add", "."]);
    await git(["commit", "-m", "two files"]);
    await git(["push", "origin", "main"]);
    await git(["checkout", "-b", "two"]);
    await Bun.write(join(dir, "a.txt"), "a-two\n");
    await Bun.write(join(dir, "b.txt"), "b-two\n");
    await git(["commit", "-am", "two"]);
    await git(["push", "origin", "two"]);
    await fetch(`${base}/api/v1/repos/dev/app/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base: "main", head: "two", title: "Two" }),
    });
    await git(["checkout", "main"]);
    await Bun.write(join(dir, "a.txt"), "a-main\n");
    await Bun.write(join(dir, "b.txt"), "b-main\n");
    await git(["commit", "-am", "main again"]);
    await git(["push", "origin", "main"]);

    const form = { ...(await drawnFields(2, "a.txt")), b0: "both" };
    const tip = await tipOf("two");
    const res = await finishPost(2, { authorization: headers["authorization"]! }, base, form);
    expect(res.status).toBe(303);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const back = await (
      await fetch(new URL(res.headers.get("location")!, base), { headers: { ...headers, cookie } })
    ).text();
    expect(back).toContain("Finish handles a pull with one conflicted text file");
    expect(await tipOf("two")).toBe(tip);
  });

  test("Finish commits the choices onto the head branch and the pull merges", async () => {
    const url = `${base}/dev/app/pulls/1/resolve`;
    const drawn = await (await fetch(`${url}?file=code.txt`, { headers })).text();
    const hidden = (name: string) =>
      new RegExp(`name="${name}" value="([0-9a-f]{40})"`).exec(drawn)![1]!;
    const post = (fields: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: headers["authorization"]!,
          "content-type": "application/x-www-form-urlencoded",
          origin: base,
        },
        body: new URLSearchParams({ file: "code.txt", head: hidden("head"), base: hidden("base"), ...fields }),
        redirect: "manual",
      });
    const flash = async (res: Response) => (
        await fetch(new URL(res.headers.get("location")!, base), {
          headers: { ...headers, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") },
        })
      ).text();

    // A head that moved since the page was drawn is refused; nothing is written.
    const stale = await post({ head: "0".repeat(40), b0: "both", b1: "ours" });
    expect(stale.status).toBe(303);
    expect(await flash(stale)).toContain("branch moved since this page was drawn");

    // A block with no choice is refused.
    const open = await post({ b0: "both" });
    expect(await flash(open)).toContain("Every block needs a choice");

    const done = await post({ b0: "both", b1: "text", t1: "mine\n" });
    expect(done.headers.get("location")).toBe("/dev/app/pulls/1");
    const pull = await (await fetch(`${base}/api/v1/repos/dev/app/pulls/1`, { headers })).json() as { mergeable?: boolean };
    expect(pull.mergeable).toBe(true);
    const raw = await (await fetch(`${base}/dev/app/raw/loud/code.txt`, { headers })).text();
    expect(raw).toBe("x\nA-main\nA-loud\nm1\nm2\nm3\nm4\nm5\nm6\nmine\ny\n");
    const log = await (await fetch(`${base}/api/v1/repos/dev/app/pulls/1`, { headers })).text();
    expect(log).not.toContain("<<<<<<<");
  });
});
