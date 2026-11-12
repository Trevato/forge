import { afterAll, beforeAll, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { askForReviews } from "./helpers/reviews.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-next-tui-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
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
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A repository with a `topic` pull open; reviews are asked for only when `reviews` says so (#11666). */
async function openTopic(name: string, reviews: boolean) {
  const repo = await createRepo(app, alice, { name, visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  askForReviews(app.db, repo.value.id, reviews);
  for (const branch of ["main", "topic"]) {
    const done = await commitToBranch(app, alice, repo.value, {
      branch,
      message: "edit",
      files: [{ path: `${branch}.txt`, content: "x\n" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const opened = await openPull(app, alice, repo.value, {
    title: "Topic",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return { repo: repo.value, pull: opened.value };
}

/** The pull screen's text once it says `wanted`, then the screen is stopped. */
async function screenSaying(repo: Awaited<ReturnType<typeof openTopic>>, wanted: string): Promise<string> {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:alice", user: alice },
    { terminal: headlessTerminal(140, 44), exitHooks: false },
  );
  tui.start();
  try {
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo.repo), repo.pull.number));
    const end = Date.now() + 20_000;
    while (!tui.screen.toText().includes(wanted)) {
      if (Date.now() > end) throw new Error(tui.screen.toText());
      await settleApp(tui);
      await Bun.sleep(20);
    }
    return tui.screen.toText();
  } finally {
    tui.stop();
  }
}

test("the terminal's pull screen says who acts next, as the page does", async () => {
  const text = await screenSaying(await openTopic("lib", true), "next: reviewer, no review yet");
  // The page's step line, too: this pull is at review.
  if (!text.includes("step: Review — ")) throw new Error(text);
});

test("with reviews off, a green pull's screen says it lands by itself, as the page does (#11666)", async () => {
  const topic = await openTopic("lib-off", false);
  const run = createRun(app.db, { repoId: topic.repo.id, kind: "check", issueId: topic.pull.id, commitOid: topic.pull.headOid });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "green" });
  const text = await screenSaying(topic, "next: queue, green, reviews are off: it lands");
  if (text.includes("next: reviewer")) throw new Error(text);
});
