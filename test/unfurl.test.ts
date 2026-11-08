/**
 * A page unfurls as one sentence from live state (#1806): an issue (a tell),
 * a pull (a change), a run, a person or organization and an app each hand
 * `page()` a `description`; a private one says only "Private." and no word
 * of what is in it; and none of the sentences speaks dev's vocabulary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  appLine,
  firstLine,
  ownerLine,
  PRIVATE_LINE,
  runLine,
  threadLine,
} from "../src/web/describe.ts";

describe("the sentences", () => {
  test("a private one is its name and 'Private.' only", () => {
    const secret = "the launch code is 1234";
    expect(
      threadLine({ private: true, word: "told", title: secret, body: secret }),
    ).toBe(PRIVATE_LINE);
    expect(
      runLine({ private: true, word: "done", commitOid: "abcdef0123", summary: secret }),
    ).toBe(PRIVATE_LINE);
    expect(
      appLine({ private: true, name: "n", description: secret, state: "live" }),
    ).toBe(PRIVATE_LINE);
  });

  test("the first non-empty line, and nothing past it", () => {
    expect(firstLine("\n\n  Hello \nmore")).toBe("Hello");
    expect(firstLine("")).toBe("");
  });

  test("a run says its verdict and its short sha", () => {
    expect(
      runLine({ private: false, word: "stopped", commitOid: "abcdef0123", summary: "did not come up" }),
    ).toBe("Stopped at abcdef0: did not come up");
  });

  test("an owner says its public repository count", () => {
    expect(ownerLine({ org: false, name: "al", publicRepos: 1, more: false })).toBe(
      "User @al · 1 public repository.",
    );
    expect(ownerLine({ org: true, name: "acme", publicRepos: 3, more: true })).toBe(
      "Organization @acme · 3+ public repositories.",
    );
  });
});

describe("the pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";
  const numbers = { tell: 0, change: 0, hushTell: 0, hushChange: 0 };
  const ids = { run: "", hushRun: "" };

  const get = async (path: string, as = ""): Promise<string> => {
    const res = await fetch(`${servers.url}${path}`, {
      headers: as === "" ? {} : { cookie: as },
    });
    expect(res.status).toBe(200);
    return await res.text();
  };
  const unfurl = (html: string): string =>
    (html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "")
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&amp;/g, "&");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-unfurl-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

    for (const [name, visibility, tag] of [
      ["open", "public", "tell"],
      ["hush", "private", "hushTell"],
    ] as const) {
      const made = await createRepo(app, a.value, {
        name,
        visibility,
        description: `${name} app for the unfurl test`,
      });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;
      const seeded = await commitToBranch(app, a.value, repo, {
        message: "Start",
        files: [
          { path: "package.json", content: `{"name":"${name}","scripts":{"start":"bun run s.ts"}}\n` },
          { path: "s.ts", content: "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n" },
        ],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const enabled = await enableApp(app, a.value, repo, { slug: name });
      if (!enabled.ok) throw new Error(String(enabled.error));
      const told = openIssue(app, a.value, repo, {
        title: `${name} tell title`,
        body: `\nSay hello from ${name}.\nSecond line stays out.`,
      });
      if (!told.ok) throw new Error(String(told.error));
      numbers[tag] = told.value.number;
      const branch = `${name}-change`;
      const made2 = await commitToBranch(app, a.value, repo, {
        branch,
        base: repo.defaultBranch,
        message: "Change",
        files: [{ path: "c.md", content: "c\n" }],
      });
      if (!made2.ok) throw new Error(JSON.stringify(made2.error));
      const pull = await openPull(app, a.value, repo, {
        title: `${name} change title`,
        body: `Make ${name} better.`,
        baseBranch: repo.defaultBranch,
        headBranch: branch,
      });
      if (!pull.ok) throw new Error(String(pull.error));
      numbers[tag === "tell" ? "change" : "hushChange"] = pull.value.number;
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.value.id,
        env: `pull-${pull.value.number}`,
        commitOid: pull.value.headOid,
        reason: "pull",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "Checked.", costUsd: 0, turns: 0 });
      ids[tag === "tell" ? "run" : "hushRun"] = run.id;
    }
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a tell opens on its state and first line", async () => {
    const line = unfurl(await get(`/alice/open/issues/${numbers.tell}`));
    expect(line).toContain("Say hello from open.");
    expect(line).not.toContain("Second line");
  });

  test("a change opens on its word and its own words", async () => {
    const line = unfurl(await get(`/alice/open/pulls/${numbers.change}`));
    expect(line).toContain("Make open better.");
  });

  test("a run opens on its verdict and short sha", async () => {
    const line = unfurl(await get(`/alice/open/runs/${ids.run}`));
    expect(line).toMatch(/ at [0-9a-f]{7}: Checked\.$/);
  });

  test("a person opens on their public repository count", async () => {
    expect(unfurl(await get("/alice"))).toBe("User @alice · 1 public repository.");
  });

  test("an app opens on its description and whether it is up", async () => {
    const line = unfurl(await get("/alice/open/app"));
    expect(line).toMatch(/^open app for the unfurl test\. Status: [a-z ·]+\.$/);
  });

  test("no sentence uses dev's vocabulary", async () => {
    for (const path of [
      `/alice/open/issues/${numbers.tell}`,
      `/alice/open/pulls/${numbers.change}`,
      `/alice/open/runs/${ids.run}`,
    ])
      expect(unfurl(await get(path))).not.toMatch(
        /\b(commit|branch|merge|pull request|issue|diff)\b/i,
      );
  });

  test("a private tell, change, run and app say 'Private.' and no more", async () => {
    for (const path of [
      `/alice/hush/issues/${numbers.hushTell}`,
      `/alice/hush/pulls/${numbers.hushChange}`,
      `/alice/hush/runs/${ids.hushRun}`,
      "/alice/hush/app",
    ]) {
      const html = await get(path, cookie);
      expect(unfurl(html)).toBe(PRIVATE_LINE);
      expect(html).not.toContain('content="Say hello from hush');
    }
  });

  test("anonymously a private page is not there at all", async () => {
    const res = await fetch(`${servers.url}/alice/hush/issues/${numbers.hushTell}`);
    expect(res.status).toBe(404);
  });
});
