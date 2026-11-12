/**
 * Tokens as a unit: one formatter, checked against a hand calculation, and
 * the quiet places a count appears — beside a file's bytes, a directory's
 * total, a run's cost, an issue's spend and a subscription's window — and
 * the places it must not, for a reader who may not see spend.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { issueUsage, recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  estimateTokens,
  formatTokens,
  textKind,
  tokenNote,
} from "../src/kernel/tokens-format.ts";
import { css } from "../src/web/style.ts";
import { tokenCount } from "../src/web/ui.ts";

describe("the formatter", () => {
  test("writes counts the way storage is written", () => {
    const cases: [number, string][] = [
      [0, "0 tok"],
      [850, "850 tok"],
      [999, "999 tok"],
      [1000, "1.0k tok"],
      [1234, "1.2k tok"],
      [9949, "9.9k tok"],
      [9950, "10k tok"], // 9.95k rounds to the whole unit, not "10.0k"
      [48_000, "48k tok"],
      [999_499, "999k tok"],
      [999_500, "1.0M tok"], // never "1000k"
      [1_100_000, "1.1M tok"],
      [12_345_678, "12M tok"],
      [2_500_000_000, "2.5B tok"],
    ];
    for (const [n, text] of cases) expect(formatTokens(n)).toBe(text);
  });

  test("an estimate carries a tilde; nonsense is zero, never NaN", () => {
    expect(formatTokens(1234, "estimated")).toBe("~1.2k tok");
    expect(formatTokens(Number.NaN)).toBe("0 tok");
    expect(formatTokens(-5)).toBe("0 tok");
  });

  test("the tooltip names the tokenizer and says when it is an estimate", () => {
    expect(tokenNote(46_500, "counted")).toBe(
      "46,500 tokens, as counted by Claude's tokenizer",
    );
    const est = tokenNote(200, "estimated", "code");
    expect(est).toContain("About 200 tokens");
    expect(est).toContain("an estimate at 3.5 bytes per token for code");
    expect(tokenNote(1, "counted")).toStartWith("1 token,");
  });
});

describe("the estimate", () => {
  test("is bytes ÷ the kind's ratio, rounded up", () => {
    // Prose 4.0, code 3.5, data 3.0 bytes per token.
    expect(estimateTokens(4000, "README.md")).toBe(1000);
    expect(estimateTokens(700, "src/a.ts")).toBe(200);
    expect(estimateTokens(701, "src/a.ts")).toBe(201); // 200.29 → 201
    expect(estimateTokens(3000, "data.json")).toBe(1000);
    expect(estimateTokens(1, "Makefile")).toBe(1); // no extension: code
    expect(estimateTokens(0, "empty.txt")).toBe(0);
  });

  test("a binary file or a size that is not a byte count has none", () => {
    expect(estimateTokens(5000, "logo.PNG")).toBeUndefined();
    expect(estimateTokens(5000, "dist/app.wasm")).toBeUndefined();
    expect(estimateTokens(-1, "src")).toBeUndefined();
    expect(estimateTokens(1.5, "a.ts")).toBeUndefined();
    expect(textKind(".bashrc")).toBe("code"); // a leading dot is a name
    expect(textKind("notes.MD")).toBe("prose");
  });
});

describe("the markup", () => {
  test("a count wears the base text utilities, not a class of its own", () => {
    const markup = String(tokenCount(1200, "estimated", "code"));
    expect(markup).toContain('class="num nowrap"');
    expect(markup).not.toContain('class="tok"');
    expect(css).not.toMatch(/\.tok\s*\{/);
  });

  test("the stylesheet defines .break and .nowrap once each", () => {
    expect(css.match(/\.break\s*\{/g)).toHaveLength(1);
    expect(css.match(/\.nowrap\s*\{/g)).toHaveLength(1);
  });
});

describe("token counts on the pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie = "";
  let bobCookie = "";
  let runId = "";
  let issueNumber = 0;

  const signIn = async (username: string) =>
    (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const get = async (path: string, c: string) =>
    (await fetch(`${servers.url}${path}`, { headers: { cookie: c } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tokens-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [
      ["alice", true],
      ["bob", false],
    ] as const) {
      const u = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      if (username === "alice") alice = u.value;
    }
    const made = await createRepo(app, alice, { name: "one", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
    const committed = await commitToBranch(app, alice, repo, {
      files: [
        { path: "README.md", content: "a".repeat(4000) },
        { path: "data.json", content: "1".repeat(3000) },
        { path: "logo.png", content: new Uint8Array(8) },
        { path: "src/a.ts", content: "x".repeat(700) },
      ],
    });
    if (!committed.ok) throw new Error(`commit: ${String(committed.error)}`);

    const issue = openIssue(app, alice, repo, { title: "make it so" });
    if (!issue.ok) throw new Error("issue");
    issueNumber = issue.value.number;
    const line = {
      repoId: repo.id,
      issueId: issue.value.id,
      agentId: null,
      subscriptionId: null,
      wallMs: 60_000,
      outcome: "ok" as const,
      at: new Date().toISOString(),
    };
    runId = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.value.id,
    }).id;
    recordUsage(app.db, {
      ...line,
      runId,
      tokensIn: 46_500,
      tokensOut: 800,
      costUsd: 0.42,
    });
    const second = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.value.id,
    }).id;
    recordUsage(app.db, {
      ...line,
      runId: second,
      tokensIn: 3500,
      tokensOut: 200,
      costUsd: 0.08,
    });

    cookie = await signIn("alice");
    bobCookie = await signIn("bob");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a directory lists each file's tokens beside its bytes, and a total", async () => {
    const page = await get("/alice/one/tree/main", cookie);
    // README.md: 4000 B = 3.9 KB; 4000 ÷ 4.0 = 1000 tokens.
    expect(page).toContain("3.9 KB · <span");
    expect(page).toContain(">~1.0k tok</span");
    // The binary file has bytes and no tokens.
    expect(page).toContain(">8 B</span");
    // Files here: 4000 + 3000 + 8 = 7008 B = 6.8 KB; 1000 + 1000 + 0 tokens.
    expect(page).toMatch(/3 files here ·\s+6\.8 KB ·\s+<span[^>]*>~2\.0k tok</);
    expect(page).toContain("subdirectories are not counted");
  });

  test("a file shows its tokens beside its size, with the estimate said", async () => {
    const page = await get("/alice/one/blob/main/src/a.ts", cookie);
    // 700 B; 700 ÷ 3.5 = 200 tokens.
    expect(page).toMatch(
      /1 lines · 700 B · <span class="num nowrap" title="About 200 tokens — an estimate at 3\.5 bytes per token for code/,
    );
    expect(page).toContain(">~200 tok</span");
  });

  test("the editor shows the file's size and tokens as opened", async () => {
    const page = await get("/alice/one/edit/main/data.json", cookie);
    expect(page).toContain('id="editor-size"');
    // 3000 B = 2.9 KB; 3000 ÷ 3.0 = 1000 tokens.
    expect(page).toMatch(/2\.9 KB · <span class="num nowrap"[^>]*>~1\.0k tok</);
  });

  test("a run shows tokens in and out beside its cost, to the owner only", async () => {
    const page = await get(`/alice/one/runs/${runId}`, cookie);
    // 46,500 in → 47k; 800 out. Counted, so no tilde.
    expect(page).toMatch(
      /id="run-tokens"\s*><span class="num nowrap" title="46,500 tokens, as counted by Claude&#39;s tokenizer"\s*>47k tok<\/span\s*>\s*in ·/,
    );
    expect(page).toContain(">800 tok</span");
    const read = await get(`/alice/one/runs/${runId}`, bobCookie);
    expect(read).not.toContain('id="run-tokens"');
  });

  test("an issue shows what the work on it consumed, summed by hand", async () => {
    // 46,500 + 3,500 = 50,000 in; 800 + 200 = 1,000 out; $0.42 + $0.08.
    expect(issueUsage(app.db, repo.id)).toBeUndefined();
    const page = await get(`/alice/one/issues/${issueNumber}`, cookie);
    expect(page).toMatch(/id="work-spent"\s*>2 runs ·\s+\$0\.50 ·/);
    expect(page).toContain(">50k tok</span");
    expect(page).toContain(">1.0k tok</span");
    const read = await get(`/alice/one/issues/${issueNumber}`, bobCookie);
    expect(read).not.toContain('id="work-spent"');
  });

  test("a subscription's windows carry tokens beside the dollars", async () => {
    const added = addSubscription(app.db, dataDir, {
      name: "account one",
      token: "sk-ant-oat01-tokens-test-account",
    });
    if (!added.ok) throw new Error(added.error);
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: repo.id, kind: "agent" }).id,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: added.value.id,
      tokensIn: 1_200_000,
      tokensOut: 34_000,
      costUsd: 2,
      wallMs: 1000,
      outcome: "ok",
      at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    // 1,200,000 + 34,000 = 1,234,000 → 1.2M, in both windows.
    const settings = await get("/settings/subscriptions", cookie);
    expect(settings.match(/>1\.2M tok</g)?.length).toBe(2);
    expect(settings).toContain("as counted by Claude");
    const board = await get("/board", cookie);
    expect(board.match(/>1\.2M tok</g)?.length).toBe(2);
  });
});
