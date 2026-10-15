import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cutWave } from "../src/story/cut.ts";
import { parseWave, writeWave } from "../src/story/wave.ts";

const link = (n: number) => `https://f.test/o/r/pulls/${n}`;
const merged = (number: number, mergedAt: string, title = `Pull ${number}`) => ({
  number,
  title,
  mergedAt,
  headBranch: `b${number}`,
});
const earlier = (version: string, date: string, listed: number[] = []) => {
  const w = writeWave({
    version,
    date,
    headline: "h",
    highlights: [1, 2, 3].map((i) => ({ title: `t${i}`, why: "w" })),
    pulls: listed.map((n) => ({ title: `#${n} Pull ${n}`, url: link(n) })),
  });
  if (!w.ok) throw w.error;
  return { path: `waves/${version}.md`, text: w.value };
};

describe("cutWave (pure)", () => {
  test("lists the pulls merged since the last wave, marks placeholders", () => {
    const r = cutWave({
      waves: [earlier("0.1.0", "2026-10-01"), earlier("0.1.1", "2026-10-10")],
      merged: () => [
        merged(1, "2026-10-02T00:00:00Z"),
        merged(7, "2026-10-12T08:00:00Z", "Late [one]"),
        merged(5, "2026-10-10T08:00:00Z"),
        { ...merged(9, "2026-10-13T00:00:00Z"), headBranch: "wave/0.1.1" },
      ],
      today: "2026-10-15",
      link,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe("waves/0.1.2.md");
    const parsed = parseWave(r.value.path, r.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.pulls.map((p) => p.url)).toEqual([link(5), link(7)]);
    expect(parsed.value.pulls[1]!.title).toBe("#7 Late one");
    expect(parsed.value.headline).toContain("TODO");
    expect(parsed.value.highlights.every((h) => h.title.includes("TODO"))).toBe(true);
  });

  test("a pull the last wave already lists is not listed again", () => {
    const r = cutWave({
      waves: [earlier("0.1.0", "2026-10-10", [5])],
      merged: () => [merged(5, "2026-10-10T08:00:00Z"), merged(6, "2026-10-10T18:00:00Z")],
      today: "2026-10-15",
      link,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toContain("/pulls/6)");
    if (r.ok) expect(r.value.text).not.toContain("/pulls/5)");
  });

  test("a wave whose only new pull was already listed is refused", () => {
    const r = cutWave({
      waves: [earlier("0.1.0", "2026-10-10", [5])],
      merged: () => [merged(5, "2026-10-10T08:00:00Z")],
      today: "2026-10-15",
      link,
    });
    expect(r.ok).toBe(false);
  });

  test("a malformed earlier wave stops the cut and is named", () => {
    const r = cutWave({
      waves: [earlier("0.1.0", "2026-10-01"), { path: "waves/0.2.0.md", text: "junk" }],
      merged: () => [merged(1, "2026-10-14T00:00:00Z")],
      today: "2026-10-15",
      link,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("waves/0.2.0.md");
  });

  test("nothing merged since the last wave is refused plainly", () => {
    const r = cutWave({
      waves: [earlier("0.1.0", "2026-10-10")],
      merged: () => [merged(1, "2026-10-09T23:59:59Z")],
      today: "2026-10-15",
      link,
    });
    expect(r).toEqual({
      ok: false,
      error: "Nothing has been merged since the last wave (0.1.0, 2026-10-10).",
    });
  });
});

describe("Cut a wave in Settings", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookies: Record<string, string> = {};
  let repo: Repo;

  const signup = async (username: string) => {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "cut-wave-password" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const cut = (who: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/olive/proj/settings/wave`, {
      method: "POST",
      headers: { cookie: cookies[who]!, ...headers },
      body: new URLSearchParams(),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cutwave-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookies = { olive: await signup("olive"), stranger: await signup("stranger") };
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: cookies.olive! },
      body: new URLSearchParams({ name: "proj", visibility: "public", description: "x" }),
      redirect: "manual",
    });
    repo = getRepo(app.db, "olive", "proj")!;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("refused for a non-admin and cross-origin, writing nothing", async () => {
    expect((await cut("stranger")).status).toBe(404);
    expect((await cut("olive", { origin: "http://evil.example" })).status).toBe(403);
    expect(app.db.query("SELECT COUNT(*) AS n FROM issue WHERE kind = 'pull'").get()).toEqual({ n: 0 });
  });

  test("an admin's cut opens a pull listing the merged pulls; a second finds nothing new", async () => {
    const olive = getUserByName(app.db, "olive")!;
    await commitToBranch(app, olive, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
    // Nothing merged yet: refused with a reason, no pull.
    const none = await cut("olive");
    expect(none.status).toBe(303);
    expect(none.headers.get("location")).toBe("/olive/proj/settings");
    expect(decodeURIComponent(none.headers.get("set-cookie") ?? "")).toContain("Nothing has been merged yet");
    for (const n of ["one", "two"]) {
      await commitToBranch(app, olive, repo, { branch: n, message: n, files: [{ path: `${n}.txt`, content: n }] });
      const p = await openPull(app, olive, repo, { title: `Feature ${n}`, baseBranch: "main", headBranch: n });
      if (!p.ok) throw new Error(p.error);
      expect((await mergePull(app, olive, repo, p.value, "merge")).ok).toBe(true);
    }
    const res = await cut("olive");
    expect(res.status).toBe(303);
    const to = res.headers.get("location")!;
    expect(to).toMatch(/^\/olive\/proj\/pulls\/\d+$/);
    const pull = getPull(app.db, repo.id, Number(to.split("/").pop()))!;
    expect(pull.headBranch).toBe("wave/0.1.0");
    const file = await Bun.spawn(["git", "show", "wave/0.1.0:waves/0.1.0.md"], {
      cwd: join(dataDir, "repos", "olive", "proj.git"),
      stdout: "pipe",
    });
    const text = await new Response(file.stdout).text();
    const parsed = parseWave("waves/0.1.0.md", text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value.pulls.map((p) => p.title)).toEqual(["#1 Feature one", "#2 Feature two"]);
  });
});
