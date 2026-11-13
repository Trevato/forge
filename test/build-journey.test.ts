/**
 * The build half of a child's first hour (#11999), in this process: a first
 * ask builds an app from the template, the app's own tests pass in the
 * check, a person lands the pull, production serves the change, and a
 * second change lands the same way. The model is `build-standin.ts`, which
 * is deterministic and runs the app's real `bun test` before it pushes; the
 * template, the crew, the check, the merge and the runtime are the forge's
 * own. It runs in this process; the same walk in a Small cell is its own issue.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull } from "../src/actions/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listOpenPulls, type Pull } from "../src/core/pulls.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { READING_V1, READING_V2, writeBuildStandIn } from "./helpers/build-standin.ts";
import { quietLogs } from "./helpers/globals.ts";
import "./helpers/roomy-disk.ts";

quietLogs();
// The walk takes about 8 s; the rest is room for a loaded check machine.
setDefaultTimeout(60_000);

const DOMAIN = "apps.test";
let dir = "";
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let checks: ChecksHandle;
let crew: CrewHandle;
let alice: User;
let bot: User;
let repo: Repo;
let slug = "";

const viaHost = (path: string) => fetch(`${servers.url}${path}`, { headers: { host: `${slug}.${DOMAIN}` }, redirect: "manual" });

async function until<T>(what: string, read: () => T | undefined | Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100); // real-timer: polling a real forge, crew and runtime that run on their own clocks
  }
  throw new Error(`${what} did not happen in ${ms / 1000}s`);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-build-journey-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
  await runtime.start();
  checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
  crew = await startCrew(app, {
    forgeUrl: servers.url,
    localUrl: servers.url,
    binary: writeBuildStandIn(dir).fake,
    concurrency: 1,
    budgetUsd: 1,
    runTimeoutMs: 30_000,
    networkRetryScale: 0,
    tickMs: 100,
  });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const agent = await createAgent(app, alice, { username: "bot", brief: "Build what is asked." });
  if (!agent.ok) throw new Error(String(agent.error));
  bot = agent.value.user;
});

afterAll(async () => {
  await crew?.stop();
  await checks?.stop();
  await runtime?.stop();
  servers?.stop();
  app?.close();
  await rm(dir, { recursive: true, force: true });
});

const fresh = () => getRepoById(app.db, repo.id)!;

/** The pull the crew's run opened for `issueId`'s work, once there is one that is not `known`. */
const newPull = (known: ReadonlySet<number>) =>
  until<Pull>("the crew's pull", () => listOpenPulls(app.db, repo.id).find((p) => !known.has(p.number)));

/**
 * Land `pull` as the person, once its preview has been built and its tests
 * have passed: the pull's own deploy run says "its tests passed".
 */
async function land(pull: Pull): Promise<void> {
  const built = await until("the pull's preview and its tests", () =>
    listRuns(app.db, repo.id, { kind: "deploy", env: `pull-${pull.number}` }).find((r) => r.state === "ok" || r.state === "failed"),
  );
  expect(built.state, built.summary ?? "").toBe("ok");
  expect(built.summary ?? "").toContain("its tests passed");
  const merged = await mergePull(app, alice, fresh(), pull, "squash");
  if (!merged.ok) throw new Error(JSON.stringify(merged.error));
}

test("a first ask builds an app from the template; its tests pass; production serves it", async () => {
  const made = await newApp(app, alice, { name: "reading", description: "A page that lists my reading. READING-V1", agent: "bot", visibility: "public" });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  repo = made.value.repo;
  slug = made.value.app.slug;
  // The template's files are the app's, whole: its own tests came with it.
  expect(made.value.issue).toBeDefined();
  const pull = await newPull(new Set());
  await land(pull);
  const served = await until("production to serve the change", async () => {
    const res = await viaHost("/reading").catch(() => undefined);
    const body = res === undefined ? "" : await res.text();
    return res?.status === 200 && body === READING_V1 ? body : undefined;
  });
  expect(served).toBe(READING_V1);
});

test("a second change lands the same way and production serves that", async () => {
  const known = new Set(listOpenPulls(app.db, repo.id).map((p) => p.number));
  const asked = openIssue(app, alice, fresh(), { title: "Two books", body: "Say two books. READING-V2" });
  if (!asked.ok) throw new Error(String(asked.error));
  const assigned = assignIssue(app, alice, fresh(), asked.value, bot);
  if (!assigned.ok) throw new Error(String(assigned.error));
  const pull = await newPull(known);
  await land(pull);
  const served = await until("production to serve the second change", async () => {
    const res = await viaHost("/reading").catch(() => undefined);
    const body = res === undefined ? "" : await res.text();
    return body === READING_V2 ? body : undefined;
  });
  expect(served).toBe(READING_V2);
});
