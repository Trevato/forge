/**
 * The pull page's merge box is §5's card and row: no merge-* class, the same
 * sentences, and the Merge form posting the same fields to the same action.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { TeamVerdict } from "../src/core/issue_teams.ts";
import { teamsCard } from "../src/web/pages/pull.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
const numbers: Record<string, number> = {};
const cells = process.env["FORGE_CELLS"];

const pageOf = async (repo: string): Promise<string> => {
  const res = await fetch(
    `${servers.url}/alice/${repo}/pulls/${numbers[repo]}/files`,
    { headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` } },
  );
  return res.text();
};

/** The class list of the card whose head names `heading`. */
const cardClassOf = (body: string, heading: string): string => {
  const at = body.indexOf(`<h2>${heading}`);
  expect(at).toBeGreaterThan(-1);
  const before = [...body.slice(0, at).matchAll(/class="(card(?: [^"]*)?)"/g)];
  return before.at(-1)?.[1] ?? "";
};

const boxOf = async (repo: string): Promise<string> => {
  const body = await pageOf(repo);
  expect(body).not.toMatch(/\bmerge-(?:box|form|headline|sub)\b/);
  const at = body.search(/<div\s+class="card mt bare"\s*>\s*<ul class="list setting-list">/);
  expect(at).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</ul>", at)).replace(/\s+/g, " ");
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-merge-card-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  for (const name of ["ready", "checks", "merged", "closed", "sliced", "fork"]) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
      const done = await commitToBranch(app, alice, repo.value, {
        ...(branch === undefined ? {} : { branch }),
        message: "change",
        files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
      });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
    if (name === "sliced") {
      const more = await commitToBranch(app, alice, repo.value, {
        branch: "topic",
        message: "a second change",
        files: [{ path: "u.txt", content: "y" }],
      });
      if (!more.ok) throw new Error(JSON.stringify(more.error));
    }
    const pull = await openPull(app, alice, repo.value, {
      title: name,
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    numbers[name] = pull.value.number;
    if (name === "checks")
      app.db.run("UPDATE repo SET require_checks = 1 WHERE id = ?", [repo.value.id]);
    if (name === "closed")
      app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?", [pull.value.id]);
    if (name === "fork")
      app.db.run("UPDATE pull SET origin_head_repo = 'bob/fork' WHERE issue_id = ?", [pull.value.id]);
    if (name === "merged") {
      const done = await mergePull(app, alice, repo.value, pull.value, "merge");
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("ready: a toned card and row holding the Merge form's action and fields", async () => {
  const box = await boxOf("ready");
  expect(box).toContain('data-tone="success"');
  expect(box).toContain('<ul class="list setting-list">');
  expect(box).toContain("Ready to merge — no conflicts with");
  expect(box).toContain(`action="/alice/ready/pulls/${numbers["ready"]}/merge"`);
  expect(box).toContain('method="post"');
  expect(box).toContain('name="strategy"');
  expect(box).toContain('<option value="merge">');
  expect(box).toContain('<option value="squash">');
  expect(box).toContain("Merge pull request");
});

test("waiting on checks: the sentence stays and the Merge button is disabled", async () => {
  const box = await boxOf("checks");
  expect(box).toContain('data-tone="attn"');
  expect(box).toContain("Waiting on checks.");
  expect(box).toContain("There is no deploy of this head yet.");
  expect(box).toContain("disabled");
  expect(box).not.toContain("/pulls/" + numbers["checks"] + "/merge");
});

test("merged: the merged tone and the sentence", async () => {
  const box = await boxOf("merged");
  expect(box).toContain('data-tone="merged"');
  expect(box).toContain("Merged.");
  expect(box).toContain("was merged into");
});


test("the merge state is the sentence's opening word with its dot, the card bare (principle 6)", async () => {
  expect(await boxOf("ready")).toMatch(/class="dot" data-tone="success" ><\/span> Ready to merge/);
  expect(await boxOf("checks")).toMatch(/data-tone="attn" ><\/span> Waiting on checks\./);
  expect(await boxOf("merged")).toMatch(/data-tone="merged" ><\/span> Merged\./);
  // Closed has no tone: a plain dot, and the word still says it.
  expect(await boxOf("closed")).toMatch(/class="dot" ><\/span> Closed without merging\./);
  expect(await boxOf("fork")).toMatch(/data-tone="attn" ><\/span> Merge on the origin\./);
});

test("the review, commits, slices and run-this-code cards are bare", async () => {
  const sliced = await pageOf("sliced");
  expect(cardClassOf(sliced, "Review")).toMatch(/\bbare\b/);
  expect(cardClassOf(sliced, "2 commits")).toMatch(/\bbare\b/);
  expect(cardClassOf(sliced, "Slices")).toMatch(/\bbare\b/);
  expect(cardClassOf(await pageOf("fork"), "Run this code?")).toMatch(/\bbare\b/);
});

test("the team verdicts are a plain list of rows, not a card (principle 7)", () => {
  const verdicts: TeamVerdict[] = [
    { team: "core", name: "Core", state: "approved", by: "bob", stale: false },
    { team: "docs", name: "Docs", state: undefined, by: undefined, stale: false },
  ];
  const out = String(teamsCard(verdicts));
  expect(out).toContain('class="team-verdicts mt"');
  expect(out).toContain('<ul class="list">');
  expect(out).not.toMatch(/class="[^"]*\bcard\b/);
  expect(out).toContain("approved by bob");
  expect(out).toContain("awaiting a reviewer");
});
