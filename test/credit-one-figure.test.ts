/**
 * One included-credit figure on every surface (#11615): a forge with $2 of
 * credit and $0.48 spent says "$1.52" on the home line, the app page, the
 * pull page and in the terminal, and no other credit figure.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { deleteSubscription, listSubscriptions } from "../src/core/subscriptions.ts";
import { getRepo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_ADMIN, PREVIEW_APP, seedPreview } from "../src/spawn/preview-seed.ts";
import { keepFunding } from "../src/spawn/funding.ts";
import { crewKeyLine } from "../src/tui/screens/crewkey.ts";
import { crewFirstLine } from "../src/web/studio/crew_key.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-credit-one-"));
  app = createApp({ dataDir, port: 0 });
  // The sample app, with a landed pull: an app with a past, so its page shows the week.
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  // The host's credit is heard after the seed, which checks a newcomer's home without one.
  await writeFile(join(dataDir, "parent.json"), "{}");
  keepFunding(dataDir, { token: "maria.bearer-token", capUsd: 2, spentUsd: 0.48 });
  // The seed gives the forge a key of its own; this forge runs on the included credit.
  for (const sub of listSubscriptions(app.db)) deleteSubscription(app.db, sub.id);
  servers = await serve(app);
  cookie = `forge_session=${createSession(app.db, getUserByName(app.db, PREVIEW_ADMIN)!.id).token}`;
  const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_APP)!;
  const admin = getUserByName(app.db, PREVIEW_ADMIN)!;
  // The app has a past: a run that cost $0.75, which the app page may show as that run's cost and never as the credit.
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: admin.id, reason: "seed" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "A run", costUsd: 0.75 });
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, admin, repo, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, admin, repo, { title: "t", body: "", baseBranch: repo.defaultBranch, headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
}, 60_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

/** Every dollar figure in a sentence of credit: what a page says about the included credit, wherever it says it. */
const creditSentences = (page: string): string[] =>
  [...page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").matchAll(/[^.<>]*included credit[^.]*\./g)].map((m) => m[0]!);
const figures = (text: string): string[] => [...text.matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]!);

test("the home line and the app page say $1.52 of $2 and no other credit figure", async () => {
  // The home line is what the next-steps card prints: render it with the function the home calls.
  const home = String(crewFirstLine(app, true));
  expect(figures(home)).toEqual(["$1.52", "$2"]);
  expect(home).toContain("$1.52 of $2 included credit");

  const page = await get(`/${PREVIEW_ADMIN}/${PREVIEW_APP}`);
  expect(page).toContain("$1.52");
  const sentences = creditSentences(page).concat(creditSentences(page.replace(/Included credit<\/dt>/, "included credit.")));
  expect(sentences.length).toBeGreaterThan(0);
  for (const sentence of sentences) for (const f of figures(sentence)) expect(["$1.52", "$2"]).toContain(f);
  const row = page.match(/id="app-credit">([\s\S]*?)<\/dd>/);
  expect(row).not.toBeNull();
  expect(figures(row![1]!)).toEqual(["$1.52", "$2"]);
  // The spend is never offered as the credit: $0.48 appears nowhere, and the run's cost is labelled as the runs'.
  expect(page).not.toContain("$0.48");
  expect(page).toMatch(/<dt>Runs cost<\/dt>\s*<dd>\s*\$0\.75/);
}, 30_000);

test("the pull page carries no credit figure of its own, and none that contradicts the home", async () => {
  const pull = await get(`/${PREVIEW_ADMIN}/${PREVIEW_APP}/pulls/${number}`);
  expect(pull).not.toContain("$0.48");
  expect(pull).not.toContain("included credit");
});

test("the terminal line says the same left figure", () => {
  const line = crewKeyLine({ app, user: undefined } as never);
  expect(line).toContain("$1.52 of $2 included credit");
});
