/**
 * The security floor (`securityFloor` in src/http/respond.ts) on every GET
 * route the two routers register, signed out and signed in (one test each,
 * over the same paths and the one seeded server), 404s included.
 * The route table is read from the routers themselves; each pattern's
 * parameters are filled from one seeded repository, issue, pull, run and app.
 * A pattern that needs a parameter the seed cannot supply is named in
 * `UNSEEDED` with why — it is still requested, with a placeholder, so its
 * miss answers carry the floor too — and the list is checked both ways.
 *
 * The two passes run 32 requests in flight against the one server; the
 * work is bounded by the route table, never by a clock (#10401, #7824).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { envDataDir } from "../src/apps/data.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createPull } from "../src/core/pulls.ts";
import { createRepo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { repoDir } from "../src/git/repos.ts";
import { buildApiRouter, buildRouter, serve, type Servers } from "../src/http/server.ts";
import { startChatBuild } from "../src/core/chat_build.ts";
import { createConversation } from "../src/core/conversations.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { pool } from "./helpers/sweep-clock.ts";

quietLogs();

/** Parameters the seed supplies; any other parameter makes a pattern unseeded. */
const SEEDED = new Set(["owner", "name", "username", "number", "ref", "oid", "path", "env", "slug", "spec", "machine", "n"]);

const ORIGIN = "needs a connected origin account and a mirror job; the seed connects none";
const MIGRATE = "needs a migration job, which only an import creates";
const ORG = "needs an organization and a team, which the seed does not create";
const BOARD = "needs a board with a panel; the seed makes no board";
const LOOK = "needs a captured look; looks come from a running app's screenshot";
const WAVE = "needs a wave of a milestone; the seed has no milestone";
const VARIANT = "needs a variant group of agent tries; the seed has none";
const LIMB = "needs a milestone with a limb; the seed has no milestone";
const FLEET = "needs a fleet operation, started by an operator action";
const SECRET = "needs a secret scope an operator has set";
const GO = "needs a short code minted by a share; the seed shares nothing";
const ARCH = "needs an archived-home operation id; the seed archives nothing";
const NOW = "the stage is one of check, review, land or live; the seed fills no word with a name it cannot guess";
const GATE = "needs a kept gate log, written only when a full gate runs on land";
const BET = "needs a bet, which the seed does not propose";
const TALK = "needs a conversation of the signed-in person; the seed starts none";
const HOOK = "needs a webhook, which the seed does not register";

/** GET patterns the seed cannot fill → why. Requested with a placeholder all the same. */
const SHOT = "needs a pin with a picture kept by refs/shots; the seed pins nothing";
const CART = "the seed pins no build with a cart (test/build-cart.test.ts covers its headers)";
const UNSEEDED: Record<string, string> = {
  "/:owner/-/teams/:team": ORG,
  "/claim/start/:token": "needs a one-time start claim token, which the seed does not mint (test/start.test.ts covers it)",
  "/talk/:id": TALK,
  "/bring/:id/:job": "needs a bring job of the signed-in person; the seed brings nothing",
  "/fleet/ops/:id": FLEET,
  "/:owner/:name/bets/:id": BET,
  "/:owner/:name/builds/:label/cart": CART,
  "/:owner/:name/builds/:label/cart.png": CART,
  "/:owner/:name/builds/:label/shots": SHOT,
  "/:owner/:name/builds/:label/shots/:file": SHOT,
  "/:owner/:name/looks/:env/:commit/:kind.png": LOOK,
  "/:owner/:name/milestones/:number/limb/:op": LIMB,
  "/:owner/:name/variants/:group": VARIANT,
  "/:owner/:name/waves/:version": WAVE,
  "/api/v1/boards/:slug/panels/:id": BOARD,
  "/api/v1/conversation/files/:id": "an attachment id exists only once its owner uploads a file; the seed holds none",
  "/api/v1/fleet/ops/:id": FLEET,
  "/api/v1/migrate/:job": MIGRATE,
  "/api/v1/migrate/:job/stream": MIGRATE,
  "/api/v1/orgs/:org": ORG,
  "/api/v1/orgs/:org/teams": ORG,
  "/api/v1/orgs/:org/teams/:team/members": ORG,
  "/api/v1/repos/:owner/:name/builds/:label/cart": CART,
  "/api/v1/repos/:owner/:name/builds/:label/shots": SHOT,
  "/api/v1/repos/:owner/:name/builds/:label/shots/looks": SHOT,
  "/api/v1/repos/:owner/:name/gates/:id/log": GATE,
  "/api/v1/repos/:owner/:name/hooks/:id/deliveries": HOOK,
  "/api/v1/repos/:owner/:name/waves/:version": WAVE,
  "/api/v1/secrets/:scope": SECRET,
  "/api/v1/user/origins/:id/browse/:owner/:name": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/blob/:ref/*path": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/branches": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/commits": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/commits/:oid": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/issues": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/issues/:number": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/labels": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/paths/:ref": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/pulls": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/pulls/:number": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/tags": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/tree/:ref": ORIGIN,
  "/api/v1/user/origins/:id/browse/:owner/:name/tree/:ref/*path": ORIGIN,
  "/api/v1/user/origins/:id/mirror/:job": ORIGIN,
  "/api/v1/user/origins/:id/mirror/:job/stream": ORIGIN,
  "/api/v1/user/origins/:id/repos": ORIGIN,
  "/api/v1/user/origins/oauth/:id": ORIGIN,
  "/go/:code": GO,
  "/home/archived/:op": ARCH,
  "/migrate/jobs/:job": MIGRATE,
  "/now/:stage": NOW,
  "/origins/:id/r/:owner/:name": ORIGIN,
  "/origins/:id/r/:owner/:name/blob/:ref/*path": ORIGIN,
  "/origins/:id/r/:owner/:name/branches": ORIGIN,
  "/origins/:id/r/:owner/:name/commit/:oid": ORIGIN,
  "/origins/:id/r/:owner/:name/commits": ORIGIN,
  "/origins/:id/r/:owner/:name/edit/:ref/*path": ORIGIN,
  "/origins/:id/r/:owner/:name/issues": ORIGIN,
  "/origins/:id/r/:owner/:name/issues/:number": ORIGIN,
  "/origins/:id/r/:owner/:name/new/:ref": ORIGIN,
  "/origins/:id/r/:owner/:name/new/:ref/*path": ORIGIN,
  "/origins/:id/r/:owner/:name/paths/:ref": ORIGIN,
  "/origins/:id/r/:owner/:name/pulls": ORIGIN,
  "/origins/:id/r/:owner/:name/pulls/:number": ORIGIN,
  "/origins/:id/r/:owner/:name/raw/:ref/*path": ORIGIN,
  "/origins/:id/r/:owner/:name/tree/:ref": ORIGIN,
  "/origins/:id/r/:owner/:name/tree/:ref/*path": ORIGIN,
  "/resilience/nightly/:job": "a nightly job's name (flake-hunt, outside-gate); the placeholder names none, so its not-found page is what gets the floor checked",
  "/settings/origins/:id/archived": ORIGIN,
  "/settings/origins/:id/mirror/:job": ORIGIN,
  "/settings/origins/:id/repos": ORIGIN,
  "/settings/origins/flows/:id": ORIGIN,
  "/settings/origins/flows/:id/stream": ORIGIN,
};

let dataDir = "";
let app: App, servers: Servers;
let cookie = "";
const fill: Record<string, string> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-floor-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "ada", email: "ada@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const ada = admin.value;
  const made = await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const seed = await commitToBranch(app, ada, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
  if (!seed.ok) throw new Error(String(seed.error));
  const branch = await commitToBranch(app, ada, repo, {
    message: "one", branch: "one", files: [{ path: "one.txt", content: "one\n" }],
  } as never);
  if (!branch.ok) throw new Error(String(branch.error));
  const issue = createIssue(app.db, { repoId: repo.id, title: "an issue", body: "b", authorId: ada.id });
  if (!issue.ok) throw new Error(String(issue.error));
  const pull = await createPull(app.db, repoDir(app.reposRoot, ada.username, repo.name), {
    repoId: repo.id, authorId: ada.id, title: "a pull", baseBranch: "main", headBranch: "one",
  });
  if (!pull.ok) throw new Error(String(pull.error));
  const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.value.id, commitOid: pull.value.headOid });
  const inserted = insertApp(app.db, { repoId: repo.id, slug: "notes", access: "public" });
  if (!inserted.ok) throw new Error(inserted.error);
  // An app database for the data routes: data routes name the production env.
  mkdirSync(envDataDir(dataDir, inserted.value.id, "production"), { recursive: true });
  const appDb = new Database(join(envDataDir(dataDir, inserted.value.id, "production"), "app.db"));
  appDb.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)");
  appDb.close();
  Object.assign(fill, {
    owner: "ada", name: "notes", username: "ada", ref: "main", oid: pull.value.headOid,
    path: "a.txt", env: "prod", slug: "notes", spec: "192", machine: "standard",
    issue: String(issue.value.number), pull: String(pull.value.number), run: run.id,
  });
  // A conversation that builds, with the version its branch holds, for the build reads.
  const talk = createConversation(app.db, ada.id);
  if (!talk.ok) throw new Error(talk.error);
  startChatBuild(app.db, talk.value.id, repo.id);
  fill.conversation = talk.value.id;
  cookie = `forge_session=${createSession(app.db, ada.id).token}`;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const paramsOf = (pattern: string): string[] =>
  [...pattern.matchAll(/[:*]([a-z_]+)/g)].map((m) => m[1]!);

const getPatterns = (): string[] =>
  [...new Set([buildRouter(), buildApiRouter()].flatMap((r) => r.routes()).filter((r) => r.method === "GET").map((r) => r.pattern))];

function pathFor(pattern: string): string {
  const number = pattern.includes("/pulls/") ? fill.pull : fill.issue;
  const runId = pattern.includes("/runs/:id") ? fill.run : pattern.includes("/conversations/:id/build") ? fill.conversation : "x";
  if (pattern.includes("/build/versions/:n/")) fill.n = "1";
  return pattern
    .replace(/[:*]([a-z_]+)/g, (_, key: string) => {
      if (key === "number") return number!;
      if (key === "id") return runId!;
      if (key === "env" && pattern.includes("/data/:env/")) return "production";
      if (key === "file" && pattern.includes("/data/:env/:file/")) return "app.db";
      return SEEDED.has(key) ? fill[key]! : "x";
    });
}

const unseeded = (pattern: string): boolean =>
  paramsOf(pattern).some(
    (key) => !SEEDED.has(key) && !(key === "id" && (pattern.includes("/runs/:id") || pattern.includes("/conversations/:id/build"))) && !(key === "file" && pattern.includes("/data/:env/:file/")),
  );

/**
 * `accept-encoding: identity` skips gzip, which only costs time here: the floor
 * is applied after compression (`compress(...).then(securityFloor)` in
 * src/http/server.ts), so the headers asserted are the same either way.
 */
async function floor(path: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${servers.url}${path}`, {
    headers: { "accept-encoding": "identity", ...headers }, redirect: "manual", signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel();
  return ["content-security-policy", "x-content-type-options", "referrer-policy"]
    .filter((h) => !res.headers.get(h))
    .map((h) => `${res.status} ${path} lacks ${h}`);
}

const allPaths = (): string[] => [...getPatterns().map(pathFor), "/no/such/path/at/all", "/api/v1/no-such-route"];

async function missingFloor(headers: Record<string, string>): Promise<string[]> {
  return (await pool(allPaths(), (path) => floor(path, headers))).flat();
}

test("every GET route, and an unknown path, carries the floor signed out", async () => {
  expect(await missingFloor({})).toEqual([]);
}, 9_000);

test("every GET route, and an unknown path, carries the floor signed in", async () => {
  expect(await missingFloor({ cookie })).toEqual([]);
}, 9_000);

test("the patterns the seed cannot fill are exactly the ones named, each with a reason", () => {
  const computed = getPatterns().filter(unseeded).sort();
  expect(computed).toEqual(Object.keys(UNSEEDED).sort());
  for (const why of Object.values(UNSEEDED)) expect(why.length).toBeGreaterThan(10);
});
