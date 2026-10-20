/** A review verdict's body is drawn from §5's components, not `.review-body` (#3619). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-verdict-body-"));
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
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, {
    title: "t",
    body: "",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  const review = await submitReview(app, alice, repo.value, pull.value, {
    state: "commented",
    body: "Looks **fine**.\n\n- one",
  });
  if (!review.ok) throw new Error(JSON.stringify(review.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a verdict's body renders its markdown inside a card, with no review-body class", async () => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}`, { headers: { cookie } });
  const page = await res.text();
  expect(page).toContain("<strong>fine</strong>");
  expect(page).toContain('class="prose comment-body"');
  expect(page).not.toContain('class="prose review-body"');
  expect(page).not.toMatch(/class="[^"]*\breview-body\b/);
});
