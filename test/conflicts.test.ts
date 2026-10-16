import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { applyChoices, parseConflicts } from "../src/git/conflicts.ts";
import { choicesFrom } from "../src/web/pages/conflicts.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

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
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "dev",
        email: "dev@f.dev",
        password: "conflicts-pass-123",
      }),
      redirect: "manual",
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

  test("readers and strangers do not get it; an unnamed file is not read", async () => {
    const url = `${base}/dev/app/pulls/1/resolve`;
    expect((await fetch(url)).status).toBe(404);
    const odd = await (await fetch(`${url}?file=../../etc/passwd`, { headers })).text();
    expect(odd).toContain("Nothing to resolve");
    expect(odd).toContain("not one of the conflicted files");
    expect(odd).not.toContain("has no conflicts");
  });

  test("the merge box offers Resolve to a writer", async () => {
    const files = await (await fetch(`${base}/dev/app/pulls/1/files`, { headers })).text();
    expect(files).toContain('href="/dev/app/pulls/1/resolve"');
  });
});
