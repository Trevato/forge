/**
 * The design half of review: the brief holds a src/web/ change to
 * docs/DESIGN.md, and the runner works out from the diff that it is one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskPrompt } from "../src/crew/brief.ts";
import { reviewInputs } from "../src/crew/runner.ts";
import { runGit } from "../src/git/env.ts";

const ITEM = "Read docs/DESIGN.md first";

describe("the design item in the review brief", () => {
  const base = {
    agent: { user: { username: "rev", displayName: "" } },
    repo: { ownerName: "alice", name: "notes", autonomyDirection: "" },
    issue: { number: 7, title: "Widen", body: "" },
    branch: "rev/7",
    forgeUrl: "http://forge.test",
    isApp: true,
    resuming: false,
    reason: "review" as const,
    comments: [],
    reviews: [],
    reviewDiff: "",
  };
  const prompt = (extra: object) =>
    taskPrompt({ ...base, ...extra } as unknown as Parameters<typeof taskPrompt>[0]);

  test("is there when the change touches src/web/, and only then", () => {
    expect(prompt({ design: true })).toContain(ITEM);
    expect(prompt({ design: false })).not.toContain(ITEM);
    expect(prompt({})).not.toContain(ITEM);
  });
});

describe("reviewInputs reads design from the diff", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-design-"));
    const git = (...args: string[]) => runGit(args, { cwd: dir });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t.invalid");
    await git("config", "user.name", "t");
    await Bun.write(join(dir, "README.md"), "x\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    for (const [branch, file] of [
      ["page", "src/web/pages/x.ts"],
      ["core", "src/core/x.ts"],
    ] as const) {
      await git("checkout", "-q", "-b", branch, "main");
      await Bun.write(join(dir, file), "export {};\n");
      await git("add", ".");
      await git("commit", "-qm", branch);
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const inputs = async (branch: string) => {
    const head = (
      await Bun.$`git -C ${dir} rev-parse ${branch}`.text()
    ).trim();
    return reviewInputs(
      {} as never,
      {} as never,
      { baseBranch: "main", headOid: head } as never,
      undefined,
      dir,
    );
  };

  test("a src/web/ change is design, a src/core/ one is not", async () => {
    expect((await inputs("page")).design).toBe(true);
    expect((await inputs("core")).design).toBe(false);
  });
});
