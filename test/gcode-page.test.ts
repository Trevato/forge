/**
 * The G-code layer view on the blob page: `?layer=` read at the boundary, the
 * 50 MB cap and the local source's own ceiling for the kind, and a big file's
 * parse made off the request thread.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { localSource } from "../src/view/local.ts";
import { INLINE_MAX, keptGcode, layerCount, parseGcode } from "../src/web/render/gcode.ts";
import { createSession } from "../src/core/sessions.ts";
import { setCrawlClock } from "../src/http/crawl.ts";
import { setStrangerLimits, strangerLimits } from "../src/http/strangers.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const MB = 1_000_000;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `layers` layers, each of `per` extruding moves; about 40 bytes a move. */
const sliced = (layers: number, per: number): string => {
  const out = ["G21", "G90", "M83"];
  for (let l = 1; l <= layers; l++) {
    out.push(`G1 Z${(l * 0.2).toFixed(1)}`);
    for (let i = 0; i < per; i++) out.push(`G1 X${(i % 90) + 5}.123 Y${((i * 7) % 90) + 5}.456 E0.01234 F1800`);
  }
  return out.join("\n") + "\n";
};

const SMALL = enc(sliced(3, 40));
/** Past the source's 5 MB fetch ceiling and the inline parse, under the 50 MB cap. */
const MID = enc(sliced(4, 40_000));
/** Past the 50 MB cap: filler, never parsed. */
const HUGE = new Uint8Array(51 * MB).fill(0x3b);
HUGE.set(enc("G1 X1 Y1 E1\n"), 0);

describe("a G-code file on the page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";
  let repo: Repo;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-gcode-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    // The page asks as a stranger: lift the code door's per-minute allowance, which is not what this tests.
    // And the main thread is not "behind" because another file in this process just filled 50 MB.
    setCrawlClock(app, Date.now, false);
    setStrangerLimits(app, { perAddress: { ...strangerLimits(app).perAddress, code: 1000 } });
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-gcode-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    cookie = `forge_session=${createSession(app.db, a.value.id).token}`;
    const created = await createRepo(app, a.value, { name: "prints", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    repo = created.value;
    const dir = repoDir(app.reposRoot, "alice", "prints");
    const made = await commitToBranch(app, a.value, repo, { message: "start", files: [{ path: "README.md", content: "# prints\n" }] });
    if (!made.ok) throw new Error("commit failed");
    const git = (args: string[], stdin?: Uint8Array | string): string => {
      const run = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdin: typeof stdin === "string" ? enc(stdin) : (stdin ?? "ignore"),
        env: { ...process.env, GIT_AUTHOR_NAME: "alice", GIT_AUTHOR_EMAIL: "a@f.dev", GIT_COMMITTER_NAME: "alice", GIT_COMMITTER_EMAIL: "a@f.dev" },
      });
      if (run.exitCode !== 0) throw new Error(`git ${args[0]}: ${run.stderr.toString()}`);
      return run.stdout.toString().trim();
    };
    const files: Record<string, Uint8Array> = { "small.gcode": SMALL, "mid.gcode": MID, "huge.gcode": HUGE };
    const lines = [git(["ls-tree", "main"])];
    for (const [name, body] of Object.entries(files)) lines.push(`100644 blob ${git(["hash-object", "-w", "--stdin"], body)}\t${name}`);
    const tree = git(["mktree"], lines.join("\n") + "\n");
    git(["update-ref", "refs/heads/main", git(["commit-tree", tree, "-p", "main", "-m", "prints"])]);
  }, 120_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** As alice by default; `stranger` as an anonymous reader, whose pages are kept and whose budget is small. */
  const page = async (path: string, query = "", stranger = false): Promise<string> => {
    const res = await fetch(`${base}/alice/prints/blob/main/${path}${query}`, stranger ? {} : { headers: { cookie } });
    const text = await res.text();
    expect(res.status === 200 ? "ok" : text.slice(0, 200)).toBe("ok");
    return text;
  };

  test("?layer= picks the layer; a stranger's non-number shows layer 1", async () => {
    expect(await page("small.gcode", "?layer=2")).toContain('value="2"');
    for (const bad of ["abc", "-3", "2.5", "0x2", "1e1", "99999999999", ""])
      expect(await page("small.gcode", `?layer=${encodeURIComponent(bad)}`)).toContain('value="1"');
  });

  test("?layer= past the last layer shows the last, and does not spoil the page kept for the real number", async () => {
    expect(await page("small.gcode", "?layer=500", true)).toContain('value="3"');
    expect(await page("small.gcode", "?layer=500", true)).toContain('value="3"');
    const real = await page("small.gcode", "?layer=2", true);
    expect(real).toContain('value="2"');
    expect(real).toContain("Layer 2");
    expect(await page("small.gcode", "?layer=0", true)).toContain('value="1"');
  });

  test("over the 50 MB cap: no drawing, the kind and size, Download", async () => {
    const text = await page("huge.gcode");
    expect(text).toContain("G-code, over the 47.7 MB the page draws");
    expect(text).toContain("48.6 MB");
    expect(text).toContain("Download");
    expect(text).not.toContain("gcode-view");
    expect(text).not.toContain('name="layer"');
  });

  test("the local source reads a G-code file past 5 MB, up to the cap, and no further", async () => {
    const source = localSource(app, repo);
    const mid = await source.blob("main", "mid.gcode");
    expect(mid.ok && mid.value.kind !== "too_large" && mid.value.size).toBe(MID.length);
    expect(MID.length).toBeGreaterThan(5 * MB);
    const huge = await source.blob("main", "huge.gcode");
    expect(huge.ok && huge.value.kind).toBe("too_large");
  });

  test("a big file is parsed on a worker and its layers are drawn", async () => {
    expect(MID.length).toBeGreaterThan(INLINE_MAX);
    const text = await page("mid.gcode", "?layer=4");
    expect(text).toContain("gcode-view");
    expect(text).toContain('value="4"');
    expect(keptGcode(MID)?.layers.length).toBe(4);
    expect(layerCount(MID)).toBe(4);
  }, 60_000);

  test("a big body not yet parsed is never parsed on the calling thread", () => {
    const fresh = enc(sliced(2, 20_000) + "; fresh\n");
    expect(fresh.length).toBeGreaterThan(INLINE_MAX);
    expect(layerCount(fresh)).toBe(0);
    expect(keptGcode(fresh)).toBeUndefined();
  });
});

describe("the parser's memory", () => {
  test("a layer of many travels then an extrusion joins without spreading arguments", () => {
    const lines = ["G1 Z0.2", "G1 X1 Y1 E1"];
    for (let i = 0; i < 150_000; i++) lines.push(`G0 X${i % 50} Y${(i + 1) % 50}`);
    lines.push("G1 X60 Y60 E2");
    const g = parseGcode(lines.join("\n"))!;
    expect(g.layers.length).toBe(1);
    // The travel run is bounded to SEGMENT_CAP-ish moves, then the extruding two.
    expect(g.layers[0]!.moves.length / 5).toBeLessThanOrEqual(20_000 * 2 + 3);
    expect(g.layers[0]!.moves.length / 5).toBeGreaterThan(20_000);
  });
});
