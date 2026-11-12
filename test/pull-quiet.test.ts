/** The pull page, the pull list and the repository head at rest (#8719): a dot and a line, not badges and cards; every action still in reach; the bytes held. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-quiet-"));
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
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, made.value, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, made.value, repo.value, {
    title: "Add a topic",
    body: "A small change.",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
const bytes = (t: string) => new TextEncoder().encode(t).length;

// Share tags with the full name (#11654): 31,983 pull, 25,359 list, budgets that plus ~170.
// Measured ~31,650 (pull: 31,130 on main plus the verdict line and the change above the check) and 25,064 (list) with the Displays entry in the account menu and palette. Each budget is that plus ~160 B, the spread the port digits and times in the page showed, so it holds the page from growing and is not a tighter squeeze. With the Your-dotfiles palette entry (#10548) the list measures 25,260, budget that plus ~170. The palette now also carries the people, three settings rows and the Tell-the-crew action (#10659): 31,869 measured on the pull page, so the pull budget is that plus ~160.
const BUDGET = { pull: 32_160, list: 25_530 };

test("the pull page's check is a line with a dot and its word, not a card around a badge", async () => {
  const text = await get(`/alice/r/pulls/${number}`);
  const line = text.match(/<p[^>]*studio-pull-check[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  expect(line).toContain('class="dot"');
  expect(line).toContain("data-pull-word");
  expect(line).not.toContain('class="badge"');
  expect(text).not.toContain("Status:");
  expect(text).toContain('id="pull-check"');
  expect(bytes(text)).toBeLessThan(BUDGET.pull);
});

test("the pull list wears a dot per row, and the head badges only Private", async () => {
  const text = await get(`/alice/r/pulls`);
  expect(text).toMatch(/class="dot"[^>]*aria-label="[^"]+"/);
  expect(text).not.toMatch(/class="row-trail"[^>]*><span class="badge"/);
  expect(text).not.toContain(">Public</span");
  expect(bytes(text)).toBeLessThan(BUDGET.list);
});

test("every page says what it is for at the top: a title naming it, one h1, and the repository's name", async () => {
  for (const [path, noun] of [["/alice/r/pulls", "ull"], ["/alice/r/issues", "ssue"], [`/alice/r/pulls/${number}`, "Add a topic"]] as const) {
    const text = await get(path);
    const title = text.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(title).toContain(noun);
    expect(title).toContain("r");
    expect(text.match(/<h1[ >]/g)?.length).toBe(1);
  }
});

test("every action the pull page offered is still on it", async () => {
  const text = await get(`/alice/r/pulls/${number}`);
  for (const needle of ["/pulls/" + number + "/comments", "Close pull request", "Pulls", "Issues", "Files"]) expect(text).toContain(needle);
});
