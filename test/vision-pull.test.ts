/**
 * A vision thought opens a small pull to docs/VISION.md (#5833): one dated
 * line under `Changes of direction`, the pull recorded on the placement, and
 * linked under the thought, on /asked and in MCP `thought`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { editFiles } from "../src/actions/contents.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { keepThought } from "../src/actions/thought.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { getIssue } from "../src/core/issues.ts";
import { placementJson, placementOf } from "../src/core/placements.ts";
import { thoughtStream } from "../src/core/thought_stream.ts";
import { createUser, type User } from "../src/core/users.ts";
import { placeThought } from "../src/crew/triage.ts";
import { directionLine, withDirection } from "../src/crew/vision.ts";
import type { Decider } from "../src/crew/decide.ts";
import { listTree, readerFor } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { replyUnder } from "../src/web/studio/feed.ts";
import { thoughtRow } from "../src/web/studio/asked_page.ts";

const visionDecider: Decider = {
  name: "stub",
  async decide(_s, questions) {
    const pick = (key: string, choice: string) => ({
      choice,
      p: 0.9,
      probabilities: Object.fromEntries(questions[key]!.options.map((o) => [o, o === choice ? 0.9 : 0])),
    });
    const out: Record<string, ReturnType<typeof pick>> = { kind: pick("kind", "vision") };
    if (questions["target"]) out["target"] = pick("target", "none");
    if (questions["pillar"]) out["pillar"] = pick("pillar", questions["pillar"].options[0]!);
    return out as never;
  },
};

describe("withDirection", () => {
  const line = "- 2026-10-25: go (thought `t1`)";
  test("a missing file is made", () => {
    expect(withDirection(null, line)).toBe(`# Vision\n\n## Changes of direction\n${line}\n`);
  });
  test("a missing section is added at the end", () => {
    expect(withDirection("# V\n\ntext\n", line)).toBe(`# V\n\ntext\n\n## Changes of direction\n${line}\n`);
  });
  test("an existing section gets the line last, before the next heading", () => {
    const got = withDirection("# V\n\n## Changes of direction\n- old\n\n## Other\nx\n", line);
    expect(got).toBe(`# V\n\n## Changes of direction\n- old\n${line}\n\n## Other\nx\n`);
  });
  test("the line is flat, dated and carries the id", () => {
    expect(directionLine("a\n\nb", "abc", new Date("2026-01-02T00:00:00Z"))).toBe("- 2026-01-02: a b (thought `abc`)");
  });
});

describe("a vision thought", () => {
  let dataDir: string;
  let app: App;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vision-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(String(made.error));
    alice = made.value;
    app.config.decider = visionDecider;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function repoWith(name: string, files: { path: string; content: string }[]): Promise<Repo> {
    const r = await createRepo(app, alice, { name, visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    await updateRepoSettings(app, alice, r.value, { autonomy: "autonomous", autonomyDirection: "x", autonomyCeilingUsd: 10, autonomySlots: 1, autonomyBy: alice.id });
    const repo = getRepoById(app.db, r.value.id)!;
    const e = await editFiles(app, alice, repo, { files });
    if (!e.ok) throw new Error(JSON.stringify(e.error));
    return getRepoById(app.db, repo.id)!;
  }

  const fileOn = async (repo: Repo, branch: string, dir: string, name: string): Promise<string> => {
    const d = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tree = await listTree(d, branch, dir);
    const e = tree.ok ? tree.value.find((x) => x.name === name) : undefined;
    if (!e) return "";
    const o = await readerFor(d).object(e.oid);
    return o.ok ? new TextDecoder().decode(o.value.body) : "";
  };

  async function think(repo: Repo, text: string) {
    const kept = keepThought(app, alice, text, "api");
    if (!kept.ok) throw new Error(kept.error);
    const p = await placeThought(app, repo, alice, { id: kept.value.id, text });
    return { id: kept.value.id, text, p };
  }

  for (const [label, files] of [
    ["with docs/VISION.md", [{ path: "docs/VISION.md", content: "# Vision\n\nWhy.\n" }]],
    ["without docs/VISION.md", [{ path: "README.md", content: "hi\n" }]],
  ] as const) {
    test(`opens the pull ${label}, and the three links appear`, async () => {
      const repo = await repoWith(label.includes("without") ? "bare" : "with", [...files]);
      const t = await think(repo, "vision: the forge steers itself");
      const slug = `${repo.ownerName}/${repo.name}`;
      const proposed = t.p.placed.find((x) => x.action === "proposed")!;
      expect(proposed.pull).toBe(proposed.number);
      expect(placementOf(app.db, t.id)!.placed.some((x) => x.pull === proposed.pull)).toBe(true);

      const pull = getIssue(app.db, repo.id, proposed.number)!;
      expect(pull.kind).toBe("pull");
      expect(pull.body).toContain(t.id);
      expect(pull.body).toContain("> vision: the forge steers itself");
      expect(pull.state).toBe("open");

      // The default branch is untouched; the branch carries the one line.
      expect(await fileOn(repo, repo.defaultBranch, "docs", "VISION.md")).not.toContain("Changes of direction");
      const edited = await fileOn(repo, `vision-${t.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`, "docs", "VISION.md");
      expect(edited).toContain("## Changes of direction\n- ");
      expect(edited).toContain(t.id);

      // Under the thought, on /asked, and in MCP `thought`.
      const href = `/${slug}/pulls/${proposed.number}`;
      expect(String(replyUnder(t.p))).toContain(href);
      const row = thoughtStream(app.db, alice).find((x) => x.id === t.id)!;
      expect(String(thoughtRow(row, 3))).toContain(href);
      const mcp = placementJson(placementOf(app.db, t.id)) as { placed: { action: string; pull?: number }[] };
      expect(mcp.placed.find((x) => x.action === "proposed")?.pull).toBe(proposed.number);
    });
  }

  test("a repository with no commits still places the thought, without a pull", async () => {
    const r = await createRepo(app, alice, { name: "empty", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    await updateRepoSettings(app, alice, r.value, { autonomy: "autonomous", autonomyDirection: "x", autonomyCeilingUsd: 10, autonomySlots: 1, autonomyBy: alice.id });
    const t = await think(getRepoById(app.db, r.value.id)!, "vision: smaller");
    expect(t.p.kind).toBe("vision");
    expect(t.p.placed.some((x) => x.action === "proposed")).toBe(false);
  });
});
