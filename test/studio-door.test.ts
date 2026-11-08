/**
 * The studio: the owner's page, every preview, the home that keeps itself
 * current, the head, the terminal and the live fragment. One of the files
 * the studio's suite was split into so no one file sets the gate's floor
 * (#2038); the rest are test/studio*.test.ts.
 *
 * One forge for the whole file (#3566): each block below owns its own
 * people and repositories on it, and one runtime — registered, never
 * started — holds the environments a block puts where a deploy would
 * have, so nothing here waits on an install, a health check or a clock.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { previewEnv, type EnvName } from "../src/apps/data.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createOrg } from "../src/actions/orgs.ts";
import {
  assignIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { KIND_CHIPS, setChip } from "../src/core/feed_chips.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  getRun,
  markServing,
} from "../src/core/runs.ts";
import { liveClientJs } from "../src/web/live.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let base: string;
let runtime: AppsRuntime;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-studio-door-"));
  // The terminal's block reads its command off this host.
  app = createApp({ dataDir, port: 0, host: "forge.example" });
  servers = await serve(app);
  base = servers.url;
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  // The forge's first account, and so its admin; bob and carol are readers
  // and strangers to alice's apps.
  await person("alice", true);
  await person("bob");
  await person("carol");
});

afterAll(async () => {
  // The slots stand in for deploys; there is no process behind them to stop.
  slots().clear();
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const PASSWORD = "a-good-passphrase";

/** A person on the shared forge, promoted past the newcomer's limits. */
async function person(username: string, adminIfFirst = false): Promise<User> {
  const made = await createUser(app.db, { origin: "seed", trusted: true,
    username,
    email: `${username}@forge.local`,
    password: PASSWORD,
    adminIfFirst,
  });
  if (!made.ok) throw new Error(made.error);
  promote(app.db, made.value);
  return made.value;
}

/** The session cookie `username` signs in with. */
const signIn = async (username: string, password = PASSWORD): Promise<string> =>
  (
    (
      await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username, password }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;

/**
 * An environment as the runtime holds it, without running a deploy: the
 * pages read `runtime.status(record)`, and a real one would mean a real
 * install and a real health check for a rendering test.
 */
interface Slot {
  readonly app: AppRecord;
  readonly env: EnvName;
  readonly chain: Promise<void>;
  readonly restarts: number[];
  readonly deploying?: unknown;
  readonly live?: unknown;
  readonly lastError?: string;
  readonly lastRunId?: string;
  readonly lastErrorCommitOid?: string;
}
const slots = (): Map<string, Slot> =>
  (runtime as unknown as { envs: Map<string, Slot> }).envs;

const putEnv = (
  record: AppRecord,
  env: EnvName,
  slot: Omit<Slot, "app" | "env" | "chain" | "restarts">,
): void => {
  slots().set(`${record.id}/${env}`, {
    app: record,
    env,
    chain: Promise.resolve(),
    restarts: [],
    ...slot,
  });
};

/** Take every environment of `record` away, as if none had ever deployed. */
const clearEnvs = (record: AppRecord): void => {
  for (const key of [...slots().keys()])
    if (key.startsWith(`${record.id}/`)) slots().delete(key);
};

describe("an owner's page lists an app once, not once in each vocabulary (#221)", () => {
  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  test("a person with one app and one plain repository renders each once, in every mode; one with no app shows a visitor no apps card at all", async () => {
    const dan = await createUser(app.db, { origin: "seed", trusted: true,
      username: "dan",
      email: "dan@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!dan.ok) throw new Error(dan.error);
    promote(app.db, dan.value);
    const cookie = await signIn("dan", "a-good-passphrase");

    const madeApp = await createRepo(app, dan.value, {
      name: "beacon",
      visibility: "public",
      description: "a lighthouse",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    const appSeeded = await commitToBranch(app, dan.value, madeApp.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!appSeeded.ok) throw new Error(JSON.stringify(appSeeded.error));
    // Not "beacon": alice's app in the terminal's block holds that slug.
    const enabled = await enableApp(app, dan.value, madeApp.value, {
      slug: "dan-beacon",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const madePlain = await createRepo(app, dan.value, {
      name: "scratch",
      visibility: "public",
      description: "not an app",
    });
    if (!madePlain.ok) throw new Error(String(madePlain.error));
    const plainSeeded = await commitToBranch(app, dan.value, madePlain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!plainSeeded.ok) throw new Error(JSON.stringify(plainSeeded.error));

    const studio = await (
      await fetch(`${base}/dan`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(studio, 'href="/dan/beacon"')).toBe(1);
    expect(occurrences(studio, 'href="/dan/scratch"')).toBe(1);
    expect(studio).toContain("<h2>Other repositories</h2>");

    const dev = await (
      await fetch(`${base}/dan`, {
        headers: { cookie: `${cookie}; forge_mode=dev` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(dev, 'href="/dan/beacon"')).toBe(1);
    expect(occurrences(dev, 'href="/dan/scratch"')).toBe(1);
    expect(dev).toContain("<h2>Apps</h2>");
    expect(dev).toContain("<h2>Other repositories</h2>");

    // Someone with repositories and no app: a visitor is not shown an empty
    // apps card, and the list is simply their repositories.
    const gus = await createUser(app.db, { origin: "seed", trusted: true,
      username: "gus",
      email: "gus@forge.local",
      password: "a-good-passphrase",
    });
    if (!gus.ok) throw new Error(gus.error);
    promote(app.db, gus.value);
    const plainOnly = await createRepo(app, gus.value, {
      name: "notebook",
      visibility: "public",
      description: "",
    });
    if (!plainOnly.ok) throw new Error(String(plainOnly.error));
    const visit = await (
      await fetch(`${base}/gus`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(visit).not.toContain("No apps yet");
    expect(visit).toContain("<h2>Repositories</h2>");
    expect(visit).toContain('href="/gus/notebook"');
  });

  test("an owner whose only repository is an app reads the empty list below as no other repositories, not as a bug", async () => {
    const eve = await createUser(app.db, { origin: "seed", trusted: true,
      username: "eve",
      email: "eve@forge.local",
      password: "a-good-passphrase",
    });
    if (!eve.ok) throw new Error(eve.error);
    promote(app.db, eve.value);
    const cookie = await signIn("eve", "a-good-passphrase");

    const madeApp = await createRepo(app, eve.value, {
      name: "lighthouse",
      visibility: "public",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    const seeded = await commitToBranch(app, eve.value, madeApp.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, eve.value, madeApp.value, {
      slug: "lighthouse",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const studio = await (
      await fetch(`${base}/eve`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(studio, 'href="/eve/lighthouse"')).toBe(1);
    expect(studio).toContain("No other repositories");
    expect(studio).not.toContain("<h2>Other repositories</h2>");
  });

  test("a private app on a public repository shows its state only to its writers: a visitor gets a plain row", async () => {
    const hal = await createUser(app.db, { origin: "seed", trusted: true,
      username: "hal",
      email: "hal@forge.local",
      password: "a-good-passphrase",
    });
    if (!hal.ok) throw new Error(hal.error);
    promote(app.db, hal.value);
    const ownerCookie = await signIn("hal", "a-good-passphrase");
    const made = await createRepo(app, hal.value, {
      name: "ledger",
      visibility: "public",
      description: "the books",
    });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, hal.value, made.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, hal.value, made.value, {
      slug: "hal-ledger",
      access: "private",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const ivy = await createUser(app.db, { origin: "seed", trusted: true,
      username: "ivy",
      email: "ivy@forge.local",
      password: "a-good-passphrase",
    });
    if (!ivy.ok) throw new Error(ivy.error);
    promote(app.db, ivy.value);
    const strangerCookie = await signIn("ivy", "a-good-passphrase");

    const visit = (cookie?: string) =>
      fetch(`${base}/hal`, {
        headers: cookie === undefined ? {} : { cookie },
        redirect: "manual",
      }).then((r) => r.text());
    // The palette index lists other, public apps and their state; the page is what is under test.
    const bare = (html: string) => html.replace(/<script[^>]*id="palette-index">.*?<\/script>/s, "");
    for (const page of [bare(await visit()), bare(await visit(strangerCookie))]) {
      // The repository is public, so it is listed — once, plainly.
      expect(occurrences(page, 'href="/hal/ledger"')).toBe(1);
      expect(page).toContain("the books");
      expect(page).not.toContain("not running");
      expect(page).not.toContain("quiet");
      expect(page).not.toContain('class="studio-word"');
    }
    // Nor does the palette hand a visitor the private app's door.
    for (const raw of [await visit(), await visit(strangerCookie)])
      expect(raw).not.toContain("/hal/ledger/app/production/open");
    const own = await visit(ownerCookie);
    expect(own).toContain("not running");
  });

  test("an org's page draws the same way: its app once, its plain repository once, and Members/Teams unmoved", async () => {
    const fay = await createUser(app.db, { origin: "seed", trusted: true,
      username: "fay",
      email: "fay@forge.local",
      password: "a-good-passphrase",
    });
    if (!fay.ok) throw new Error(fay.error);
    promote(app.db, fay.value);
    const cookie = await signIn("fay", "a-good-passphrase");

    const org = await createOrg(app, fay.value, "vega");
    if (!org.ok) throw new Error(org.error);

    const madeApp = await createRepo(app, fay.value, {
      name: "anvil",
      owner: "vega",
      visibility: "public",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    const appSeeded = await commitToBranch(app, fay.value, madeApp.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!appSeeded.ok) throw new Error(JSON.stringify(appSeeded.error));
    const enabled = await enableApp(app, fay.value, madeApp.value, {
      slug: "anvil",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const madePlain = await createRepo(app, fay.value, {
      name: "ledger",
      owner: "vega",
      visibility: "public",
    });
    if (!madePlain.ok) throw new Error(String(madePlain.error));
    const plainSeeded = await commitToBranch(app, fay.value, madePlain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!plainSeeded.ok) throw new Error(JSON.stringify(plainSeeded.error));

    const studio = await (
      await fetch(`${base}/vega`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(studio, 'href="/vega/anvil"')).toBe(1);
    expect(occurrences(studio, 'href="/vega/ledger"')).toBe(1);
    expect(studio).toContain('<h2>Members</h2>');
    expect(studio).toContain('<h2 id="teams">Teams</h2>');

    const dev = await (
      await fetch(`${base}/vega`, {
        headers: { cookie: `${cookie}; forge_mode=dev` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(dev, 'href="/vega/anvil"')).toBe(1);
    expect(occurrences(dev, 'href="/vega/ledger"')).toBe(1);
  });
});

describe("every open pull's preview on the studio page", () => {
  let cookie: string;
  let repo: Repo;
  let record: AppRecord;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  // The tests take turns on one repository: the first leaves no pull open,
  // which is the second's start.
  beforeAll(async () => {
    const alice = getUserByName(app.db, "alice")!;
    cookie = await signIn("alice");
    const made = await createRepo(app, alice, {
      name: "widget",
      visibility: "public",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "w\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "widget" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
  });

  test("an open pull's preview host and open link render; none do once nothing is open", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const before = await (await get("/alice/widget")).text();
    expect(before).not.toContain("<h2>Previews</h2>");

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: repo.defaultBranch,
      message: "Add X",
      files: [{ path: "X.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add X",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;

    const page = await (await get("/alice/widget")).text();
    expect(page).toContain("<h2>Previews</h2>");
    expect(page).toContain(`href="/alice/widget/app/pull-${pull.number}/open"`);
    expect(page).toContain(`#${pull.number} Add X`);

    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
    const after = await (await get("/alice/widget")).text();
    expect(after).not.toContain("<h2>Previews</h2>");
    expect(after).not.toContain(`pull-${pull.number}/open`);
  });

  test("a change's page names its preview's data as its own copy and gives the moment it was taken; production's card does not", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/y",
      base: repo.defaultBranch,
      message: "Add Y",
      files: [{ path: "Y.md", content: "y\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add Y",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/y",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);

    // Production and the preview both serving, as a deploy leaves them;
    // test/apps.test.ts proves a real preview gets its copy of the data.
    const serving = (commitOid: string) => ({
      live: {
        commitOid,
        handle: { port: 4321 },
        runId: "fake",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    putEnv(record, "production", serving("0".repeat(40)));
    putEnv(record, env, serving(pull.headOid));

    const note = "its own copy of production's data, taken";

    const appPage = await (await get("/alice/widget")).text();
    expect(appPage).toContain(note);
    // Production's own card, above the previews list, never says it.
    const production = appPage.slice(0, appPage.indexOf("<h2>Previews</h2>"));
    expect(production).not.toContain(note);

    const changePage = await (
      await get(`/alice/widget/pulls/${pull.number}`)
    ).text();
    expect(changePage).toContain("<h2>Preview</h2>");
    expect(changePage).toContain(note);
  });
});

/**
 * The studio home keeps itself current: Asks you, Your apps and On you are
 * each a live region — no second fragment endpoint, the same `studioHome`
 * render as the first paint, fetched again on a matching event and swapped
 * in place by `liveRegionsJs` (`src/web/client.ts`).
 */
describe("the studio home keeps itself current", () => {
  let alice: User;
  let repo: Repo;
  let cookie: string;
  let pull: Pull;
  let readme: Issue;

  const get = (extraCookie = "") =>
    fetch(`${base}/feed`, {
      headers: {
        cookie: `${cookie}${extraCookie}; forge_mode=studio`,
      },
      redirect: "manual",
    });

  beforeAll(async () => {
    alice = getUserByName(app.db, "alice")!;
    cookie = await signIn("alice");
    const made = await createRepo(app, alice, {
      name: "signals",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "s\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "signals" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    const scoutUser = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: "main",
      message: "Add x",
      files: [{ path: "x.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scoutUser, repo, {
      title: "Add x",
      body: "",
      baseBranch: "main",
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed" });

    const asked = openIssue(app, alice, repo, { title: "Write the README" });
    if (!asked.ok) throw new Error(String(asked.error));
    readme = asked.value;
    expect(assignIssue(app, alice, repo, readme, alice).ok).toBe(true);
  });

  test("Your apps is a live region and the home has no On you, with the security floor's headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const home = await res.text();
    expect(home).toMatch(/id="live-apps"\s*\n?\s*data-live="/);
    expect(home).not.toContain("live-on-you");
    expect(await withScripts(servers.url, home)).toContain("new EventSource('/events')");
  });

  test("chips do not touch Your apps: it lists apps, not feed items", async () => {
    for (const kind of KIND_CHIPS) setChip(app.db, alice.id, { kind: "kind", value: kind }, true);
    const res = await fetch(`${base}/live/apps`, { headers: { cookie: `${cookie}; forge_mode=studio` } });
    expect(await res.text()).toContain(`${repo.name}`);
    for (const kind of KIND_CHIPS) setChip(app.db, alice.id, { kind: "kind", value: kind }, false);
  });

  test("each region on the home has an address of its own, answering with that region alone and 304 when it has not changed", async () => {
    const page = await (await get()).text();
    expect(page).toContain('data-live-src="/live/apps"');
    expect(page).not.toContain("/live/on-you");

    const headers = { cookie: `${cookie}; forge_mode=studio` };
    const apps = await fetch(`${base}/live/apps`, { headers });
    expect(apps.status).toBe(200);
    const appsText = await apps.text();
    expect(appsText).toContain('id="live-apps"');
    expect(appsText).toContain(`${repo.name}`);
    expect(appsText).not.toContain("<html");
    const tag = apps.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{16}"$/);
    const unchanged = await fetch(`${base}/live/apps`, {
      headers: { ...headers, "if-none-match": tag! },
    });
    expect(unchanged.status).toBe(304);

    const onYou = await fetch(`${base}/live/on-you`, { headers });
    expect(onYou.status).toBe(200);
    expect(await onYou.text()).toContain('id="live-on-you"');

    // Signed out, the regions are nobody's.
    expect((await fetch(`${base}/live/apps`)).status).toBe(404);
    expect((await fetch(`${base}/live/on-you`)).status).toBe(404);
  });

  test("a signed-out request gets a signed-out home: no per-viewer live regions, nothing of alice's", async () => {
    const res = await fetch(`${base}/`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const home = await res.text();
    expect(home).not.toContain('id="live-asks"');
    expect(home).not.toContain('id="live-on-you"');
    expect(home).not.toContain("Add x");
    expect(home).not.toContain("Write the README");
  });

  test("a card leaves On you once its issue closes", async () => {
    // The On you region alone: the timeline still tells of the issue, as a
    // post does after it is done (#599).
    const onYou = () =>
      fetch(`${base}/live/on-you`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      }).then((r) => r.text());
    const before = await onYou();
    expect(before).toContain("Write the README");

    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
    expect(setIssueState(app, alice, repo, readme, "closed").ok).toBe(true);

    const after = await onYou();
    expect(after).not.toContain("Write the README");
  });
});

/**
 * The studio head of an app that is not up: the same facts the App page
 * shows — why, the deploy that says the rest, and the way to try again.
 */
describe("the studio head says why the app is not up", () => {
  let repo: Repo;
  let record: AppRecord;
  let deploy: string;
  let writer: string;
  let reader: string;

  const head = (cookie: string) =>
    fetch(`${base}/alice/notes`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  /** The home's own shelf row for this app — the badge issue #201 is about. */
  // The shelf's rows are `/apps` (#599: home is the feed).
  const shelfBadge = async (cookie: string): Promise<string> => {
    const home = await (
      await fetch(`${base}/apps`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    const at = home.indexOf('href="/alice/notes"');
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    const row = home.slice(start, home.indexOf("</li>", at) + 5);
    return row.match(/<span class="badge"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
  };

  /** Production as the runtime holds it, in place of a real deploy. */
  const put = (slot: Omit<Slot, "app" | "env" | "chain" | "restarts">): void =>
    putEnv(record, "production", slot);

  beforeAll(async () => {
    const alice = getUserByName(app.db, "alice")!;
    writer = await signIn("alice");
    reader = await signIn("bob");
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "public",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "notes\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: seeded.value.commitOid,
      reason: "push",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: "the deploy failed",
    });
    deploy = run.id;
  });

  test("a failed production says what failed, links its deploy, and offers Redeploy to a writer only — and offers no live link to the host", async () => {
    put({
      lastError: "the deploy failed: <install> exited 1",
      lastRunId: deploy,
    });
    const mine = await head(writer);
    expect(mine).toContain("not up");
    // The error is the app's own output: shown, and escaped.
    expect(mine).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(mine).not.toContain("<install>");
    expect(mine).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).toContain('href="/-/confirm?to=%2Falice%2Fnotes%2Fapp%2Fproduction%2Fstop"');
    expect(mine).not.toContain('href="/alice/notes/app/production/open"');
    expect(mine).toContain('title="The last deploy failed"');

    const theirs = await head(reader);
    expect(theirs).toContain("not up");
    expect(theirs).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(theirs).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(theirs).not.toContain("/app/production/redeploy");
    expect(theirs).not.toContain("%2Fapp%2Fproduction%2Fstop");
    expect(theirs).not.toContain('href="/alice/notes/app/production/open"');
  });

  // Issue #201: the shelf used to print the runtime's raw `EnvState` for a
  // failed or deploying production, disagreeing with the app's own head
  // above — which has always spoken the studio's five-ish words.
  test("a failed production reads 'not up' on the home shelf too, never the runtime's own word 'failed'", async () => {
    put({
      lastError: "the deploy failed: <install> exited 1",
      lastRunId: deploy,
    });
    expect(await shelfBadge(writer)).toBe("not up");
  });

  test("a stopped production says it is not running and offers Redeploy, not Stop — and no live link to the host", async () => {
    put({ lastRunId: deploy });
    const mine = await head(writer);
    expect(mine).toContain("not running");
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).not.toContain('href="/-/confirm?to=%2Falice%2Fnotes%2Fapp%2Fproduction%2Fstop"');
    expect(mine).not.toContain('href="/alice/notes/app/production/open"');
    expect(mine).toContain('title="Nothing is running yet. The app starts when it is deployed."');
    expect(await shelfBadge(writer)).toBe("not running");
  });

  test("a deploying production says so where the button was, not a link to a host nothing is serving yet", async () => {
    put({
      deploying: { run: { id: deploy, commitOid: "0".repeat(40) } },
    });
    const mine = await head(writer);
    expect(mine).toContain("starting");
    expect(mine).not.toContain('href="/alice/notes/app/production/open"');
    expect(mine).toContain('title="Still deploying"');
    // The runtime's own word for this state is "deploying" — the shelf
    // says "starting" instead, same as the head above.
    expect(await shelfBadge(writer)).toBe("starting");
  });

  test("a serving app with red tests still reads as serving, with the failure in its own words, and is still open-able", async () => {
    put({
      live: {
        commitOid: "0".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        testsFailed: "1 of 3 tests failed",
        manifest: { tty: null },
      },
    });
    const mine = await head(writer);
    expect(mine).toContain("serving · tests failed");
    expect(mine).not.toContain("not up");
    expect(mine).toContain("serving · tests failed: 1 of 3 tests failed");
    expect(mine).toContain('href="/alice/notes/app/production/open"');
    expect(await shelfBadge(writer)).toBe("serving · tests failed");
  });

  test("a newer push that failed to come up while an older deploy keeps serving: live, not plain green, both commits named, its run linked", async () => {
    const failed = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "2".repeat(40),
      reason: "push",
    });
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, {
      state: "failed",
      summary: "forge.json: JSON Parse error: Unexpected token '}'",
    });
    put({
      live: {
        commitOid: "1".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        manifest: { tty: null },
      },
      lastError: "forge.json: JSON Parse error: Unexpected token '}'",
      lastRunId: failed.id,
      lastErrorCommitOid: "2".repeat(40),
    });
    const mine = await head(writer);
    // It answers — still "live", never "not up" — but not untroubled green.
    expect(mine).toContain("live");
    expect(mine).not.toContain("not up");
    expect(mine).toContain('href="/alice/notes/app/production/open"');
    // Both commits, named.
    expect(mine).toContain("1111111");
    expect(mine).toContain("2222222");
    expect(mine).toContain("did not come up");
    expect(mine).toContain(
      "forge.json: JSON Parse error: Unexpected token &#39;}&#39;",
    );
    // The failed run's log, one click away.
    expect(mine).toContain(`href="/alice/notes/runs/${failed.id}"`);
  });

  test("a clean deploy with no failure behind it is unchanged: plain live, no failed-run link", async () => {
    put({
      live: {
        commitOid: "1".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        manifest: { tty: null },
      },
    });
    const mine = await head(writer);
    expect(mine).toContain("live");
    expect(mine).not.toContain("did not come up");
  });
});

/**
 * The studio app page's Terminal — the one door an operator has into what
 * is running. `terminalFor` (`src/actions/apps.ts`) is the single fact both
 * this page and the dev App page read; this only checks it is drawn (or
 * withheld) correctly, not recomputed.
 */
describe("the studio app page's terminal", () => {
  let repo: Repo;
  let record: AppRecord;
  let writer: string;
  let reader: string;
  // What the forge had before this block gave it a listener and a key.
  let before: Pick<App["config"], "sshPort" | "sshHostKey">;

  const putLive = (tty: string | null): void =>
    putEnv(record, "production", {
      live: {
        commitOid: "a".repeat(40),
        handle: { port: 4321 },
        runId: "fake",
        since: new Date().toISOString(),
        manifest: { tty },
      },
    });

  const appPage = (cookie: string) =>
    fetch(`${base}/alice/beacon`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  beforeAll(async () => {
    before = { ...app.config };
    app.config.sshPort = 2222;
    app.config.sshHostKey =
      "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const alice = getUserByName(app.db, "alice")!;
    writer = await signIn("alice");
    reader = await signIn("bob");
    const made = await createRepo(app, alice, {
      name: "beacon",
      visibility: "public",
      description: "a light that stays on",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "beacon\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "beacon" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
  });

  afterAll(() => {
    if (before.sshPort === undefined) delete app.config.sshPort;
    else app.config.sshPort = before.sshPort;
    if (before.sshHostKey === undefined) delete app.config.sshHostKey;
    else app.config.sshHostKey = before.sshHostKey;
  });

  test("a writer sees the exact command and the host key; a reader sees neither", async () => {
    putLive("bun run src/tty.ts");
    const mine = await appPage(writer);
    expect(mine).toContain("ssh -p 2222 beacon@forge.example");
    expect(mine).toContain("host key SHA256:abcdefghijklmnopqrstuvwxyz");
    // Wrapped in the marker an email-scanning edge honours, so the
    // login@host in the command is never rewritten into a mailto: link —
    // and the command itself sits between the markers unchanged.
    expect(mine).toContain(
      "<!--email_off-->ssh -p 2222 beacon@forge.example<!--/email_off-->",
    );
    const theirs = await appPage(reader);
    expect(theirs).not.toContain("ssh -p 2222 beacon@forge.example");
    expect(theirs).not.toContain("The terminal is off");
  });

  test("an app with no tty says the terminal is off, to a writer only", async () => {
    putLive(null);
    const mine = await appPage(writer);
    expect(mine).toContain("The terminal is off");
    expect(mine).not.toContain("ssh -p 2222 beacon@forge.example");
    const theirs = await appPage(reader);
    expect(theirs).not.toContain("The terminal is off");
  });

  // Issue #283: a hosted forge (an app of another forge) defaults
  // FORGE_SSH_PORT to 0, so serve() never opens a listener — every app on
  // it declares a tty but has nothing to connect it to. The generic "The
  // terminal is off." leaves a reader with no idea why or what to do; this
  // asserts the line names FORGE_SSH_PORT instead, composed from the same
  // sshPort field the other tests here already pin (#77's ground) rather
  // than by shutting a real listener down.
  test("a hosted forge with no SSH listener says why, and names FORGE_SSH_PORT", async () => {
    putLive("bun run src/tty.ts");
    app.config.sshPort = 0;
    try {
      const mine = await appPage(writer);
      expect(mine).toContain("FORGE_SSH_PORT");
      expect(mine).not.toContain("ssh -p 2222 beacon@forge.example");
      expect(mine).not.toContain("The terminal is off.</p>");
    } finally {
      app.config.sshPort = 2222;
    }
  });
});

/**
 * GET /:owner/:name/app/state — the fragment the studio page's live client
 * fetches on a deploy run event, and swaps into `#app-head`/`#app-previews`
 * in place of a reload. It is authorized exactly as the studio page, and
 * renders from the same `appPanels` function the page's first paint does.
 */
describe("the app's live fragment: /:owner/:name/app/state", () => {
  let repo: Repo;
  let record: AppRecord;
  let owner: string;
  let stranger: string;

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    const alice = getUserByName(app.db, "alice")!;
    owner = await signIn("alice");
    stranger = await signIn("carol");
    const made = await createRepo(app, alice, {
      name: "vault",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "v\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "vault" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
  });

  // Every test starts from an app nothing has deployed: one test's preview
  // or production slot would otherwise show in the next's head card. Each
  // opens a pull of its own, and reads only that pull's row.
  beforeEach(() => clearEnvs(record));

  test("renders the head card for a viewer who may see it, with the security floor's headers; refuses one who may not, same as the page", async () => {
    const fragment = await get("/alice/vault/app/state", owner);
    expect(fragment.status).toBe(200);
    expect(fragment.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fragment.headers.get("referrer-policy")).toBe("same-origin");
    const text = await fragment.text();
    expect(text).toContain('id="app-head"');
    expect(text).toContain('id="app-previews"');
    expect(text).toContain("not running");

    const page = await (await get("/alice/vault", owner)).text();
    expect(page).toContain("not running");

    const refusedFragment = await get("/alice/vault/app/state", stranger);
    expect(refusedFragment.status).toBe(404);
    const refusedPage = await get("/alice/vault", stranger);
    expect(refusedPage.status).toBe(404);
  });

  test("a change's page has a state fragment of its own: its current word, drawn by the page's own function, refused to whoever the page refuses, and named by the client script (#1094)", async () => {
    const branch = await commitToBranch(app, getUserByName(app.db, "alice")!, repo, {
      branch: "feature/ship-it",
      base: "main",
      message: "Ship it",
      files: [{ path: "SHIP.md", content: "ship\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, getUserByName(app.db, "alice")!, repo, {
      title: "Ship it",
      body: "",
      baseBranch: "main",
      headBranch: "feature/ship-it",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const n = opened.value.number;

    const fragment = await get(`/alice/vault/pulls/${n}/state`, owner);
    expect(fragment.status).toBe(200);
    expect(fragment.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fragment.headers.get("referrer-policy")).toBe("same-origin");
    const text = await fragment.text();
    expect(text).toContain('id="pull-check"');
    expect(text).toContain('id="pull-preview"');
    expect(text).toContain("studio-pull-check");
    // The page's first paint carries the very same check line.
    const pageText = await (await get(`/alice/vault/pulls/${n}`, owner)).text();
    const line = (t: string) =>
      t.match(/<p[^>]*studio-pull-check[^>]*>[\s\S]*?<\/p>/)?.[0];
    expect(line(text)).toBeDefined();
    expect(line(pageText)).toBe(line(text));
    expect(pageText).toContain('id="pull-check"');
    expect(pageText).toContain('data-head="');

    expect((await get(`/alice/vault/pulls/${n}/state`, stranger)).status).toBe(404);
    expect((await get(`/alice/vault/pulls/999/state`, owner)).status).toBe(404);

    const merged = await mergePull(app, getUserByName(app.db, "alice")!, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    const after = await (await get(`/alice/vault/pulls/${n}/state`, owner)).text();
    expect(line(after)).not.toBe(line(text));
    // The squash lands a new commit; the fragment names it, so a page that
    // saw the merge live can match production's serving against it.
    const headOf = (t: string) => t.match(/data-head="([0-9a-f]{40})"/)?.[1];
    expect(headOf(text)).toBeDefined();
    expect(headOf(after)).toBeDefined();
    expect(headOf(after)).not.toBe(headOf(text));
    expect(liveClientJs).toContain("#pull-check [data-head]");

    expect(liveClientJs).toContain("'/pulls/' + number + '/state'");
    expect(liveClientJs).toContain("'pull.merged'");
    expect(liveClientJs).toContain("'app.serving'");
  });

  test("Now has an address of its own: the page's region names it, the fragment answers with the same region, and unchanged bytes come back 304", async () => {
    const page = await (await get("/alice/vault", owner)).text();
    expect(page).toContain('id="live-now"');
    expect(page).toContain('data-live-src="/alice/vault/app/now"');

    const first = await get("/alice/vault/app/now", owner);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    const text = await first.text();
    // The tag rides in the markup as well, for a proxy that drops the header.
    expect(text).toMatch(/^\s*<div data-etag="[0-9a-f]{16}"/);
    expect(`"${/data-etag="([0-9a-f]{16})"/.exec(text)![1]}"`).toBe(etag!);
    expect(text).toContain('id="live-now"');
    expect(text).toContain('data-live="run.queued,run.started,run.finished,pull.*,issue.*"');
    expect(text).toContain('data-live-src="/alice/vault/app/now"');
    expect(text).toContain("<h2>Now</h2>");

    // The same bytes again: nothing to paint, and nothing sent to paint.
    const again = await fetch(`${base}/alice/vault/app/now`, {
      headers: {
        cookie: `${owner}; forge_mode=studio`,
        "if-none-match": etag!,
      },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");

    // A stale tag is answered in full.
    const stale = await fetch(`${base}/alice/vault/app/now`, {
      headers: { cookie: `${owner}; forge_mode=studio`, "if-none-match": '"0"' },
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain("<h2>Now</h2>");

    expect((await get("/alice/vault/app/now", stranger)).status).toBe(404);
    expect((await fetch(`${base}/alice/vault/app/now`)).status).toBe(404);
  });

  test("a preview flips from deploying to live between two calls, and the link stays correct", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: repo.defaultBranch,
      message: "Add X",
      files: [{ path: "X.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add X",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);
    const link = `href="/alice/vault/app/${env}/open"`;

    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, deployRun.id);
    putEnv(record, env, {
      deploying: {
        run: { id: deployRun.id, commitOid: pull.headOid },
        abort: new AbortController(),
      },
    });
    const starting = await (await get("/alice/vault/app/state", owner)).text();
    expect(starting).toContain("starting");
    expect(starting).not.toContain(">live<");
    expect(starting).toContain(link);

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv(record, env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4321 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const live = await (await get("/alice/vault/app/state", owner)).text();
    expect(live).not.toContain("starting");
    expect(live).toContain(">live<");
    expect(live).toContain(link);
  });

  test("the fragment's markup is what the live client's status announcement reads: the head's word in a badge, a preview row's word beside its `#N title`", async () => {
    // `live.ts`'s `announceSwap` finds the head's word at `.page-head h1
    // .badge` and, for a preview row, the pull's label at the start of
    // `.row-meta` beside its word at `.row-trail .badge`. If this markup
    // ever moves, the announcement goes silent without a test failing here.
    const text = await (await get("/alice/vault/app/state", owner)).text();
    expect(text).toContain('class="page-head"');
    expect(text).toMatch(/class="page-head"[\s\S]*?<h1 class="bar">[\s\S]*?class="badge"[^>]*>not running</);

    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/announce",
      base: repo.defaultBranch,
      message: "Add Y",
      files: [{ path: "Y.md", content: "y\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add Y",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/announce",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, deployRun.id);
    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv(record, env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4323 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const withPreview = await (
      await get("/alice/vault/app/state", owner)
    ).text();
    const label = `#${pull.number} Add Y`;
    expect(withPreview).toContain(`class="row-meta"`);
    expect(withPreview).toContain(`class="row-trail"`);
    expect(withPreview).toContain(label);
    expect(
      new RegExp(`${label}[\\s\\S]*?class="row-trail"[\\s\\S]*?>live<`).test(
        withPreview,
      ),
    ).toBe(true);
  });

  test("the head measures from the push, not from the permit it waited for: a deploy queued 5s reads 6.0s after the push and names the wait", async () => {
    const createdAt = new Date(Date.now() - 20_000).toISOString();
    const deployStartedAt = new Date(
      Date.parse(createdAt) + 5_000,
    ).toISOString();
    const servingAt = new Date(
      Date.parse(deployStartedAt) + 1_000,
    ).toISOString();
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "cafebabe",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv(record, "production", {
      live: {
        commitOid: "cafebabe",
        handle: { port: 4322 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt,
        manifest: { tty: null },
      },
    });

    const head = await (await get("/alice/vault/app/state", owner)).text();
    expect(head).toContain("live 6.0s after the push · 5.0s queued");
    expect(head).not.toContain("1.0s after the push");

    // The same deployment with no wait for a permit says only the one
    // number, exactly as it always has.
    putEnv(record, "production", {
      live: {
        commitOid: "cafebabe",
        handle: { port: 4322 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt: deployStartedAt,
        deployStartedAt,
        manifest: { tty: null },
      },
    });
    const prompt = await (await get("/alice/vault/app/state", owner)).text();
    expect(prompt).toContain("live 1.0s after the push");
    expect(prompt).not.toContain("queued");

    // A deploy no push asked for — a redeploy someone pressed — carries no
    // push instant, and its words never claim one.
    putEnv(record, "production", {
      live: {
        commitOid: "cafebabe",
        handle: { port: 4322 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        deployStartedAt,
        manifest: { tty: null },
      },
    });
    const pressed = await (await get("/alice/vault/app/state", owner)).text();
    expect(pressed).toContain("live 1.0s after the deploy started");
    expect(pressed).not.toContain("after the push");
  });

  test("app.serving reaches the repo's stream with the shape the live client keys on, the instant the swap-in happens — before its run has finished", async () => {
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "deadbeef",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    const served = markServing(app.db, deployRun.id);
    expect(served?.servingAt).toBeDefined();

    const stream = await fetch(`${base}/alice/vault/stream`, {
      headers: { cookie: owner },
    });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // The stream says it is connected as it subscribes: from here on, an
    // append reaches it — no sleep stands in for that.
    while (!buffer.includes(": connected\n\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("the stream closed before it connected");
      buffer += decoder.decode(value);
    }

    // The exact append `AppsRuntime` makes at the swap-in (runtime.ts),
    // republished here so the test does not have to spin up a real deploy.
    app.bus.append({
      kind: "app.serving",
      repoId: repo.id,
      payload: {
        app: record.slug,
        env: "production",
        commitOid: deployRun.commitOid,
        servingAt: served!.servingAt,
        testsRunning: true,
      },
    });

    let event: Record<string, unknown> | undefined;
    const deadline = Date.now() + 5_000;
    while (!event && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (!/^event: app\.serving$/m.test(frame)) continue;
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (data !== undefined) event = JSON.parse(data);
      }
    }
    if (!event) throw new Error(`never came: still waiting while !event`);
    await reader.cancel().catch(() => {});
    expect(event).toBeDefined();
    expect(event?.["kind"]).toBe("app.serving");
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["app"]).toBe(record.slug);
    expect(payload["env"]).toBe("production");
    expect(payload["commitOid"]).toBe(deployRun.commitOid);
    expect(payload["servingAt"]).toBe(served!.servingAt);
    expect(payload["testsRunning"]).toBe(true);

    // finishRun never ran: run.finished has not fired, yet app.serving
    // already has. That gap is the whole point of the issue.
    expect(getRun(app.db, deployRun.id)?.state).toBe("running");
  });

  test("production's Open the app link appears only once it is serving, and the fragment after a swap flips it", async () => {
    const link = 'href="/alice/vault/app/production/open"';
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "cafed00d",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    putEnv(record, "production", {
      deploying: {
        run: { id: deployRun.id, commitOid: "cafed00d" },
        abort: new AbortController(),
      },
    });
    const deploying = await (await get("/alice/vault/app/state", owner)).text();
    expect(deploying).toContain("starting");
    expect(deploying).not.toContain(link);

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv(record, "production", {
      live: {
        commitOid: "cafed00d",
        handle: { port: 4325 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const serving = await (await get("/alice/vault/app/state", owner)).text();
    expect(serving).toContain(">live<");
    expect(serving).toContain(link);
  });
  test("a preview row says how fast it got there in envFacts' own words, links its deploy run, and keeps its link and sentence while deploying or after its tests failed", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: repo.defaultBranch,
      message: "Add F",
      files: [{ path: "F.md", content: "f\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add F",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);
    const open = `href="/alice/vault/app/${env}/open"`;
    const label = `#${pull.number} Add F`;
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid: pull.headOid,
      reason: "pull",
    });
    const runLink = `href="/alice/vault/runs/${deployRun.id}"`;
    // This pull's own row out of the previews panel, so nothing the head
    // card or another pull's row says can pass for it.
    const rowOf = (text: string): string => {
      const panel = text.slice(text.indexOf('id="app-previews"'));
      const at = panel.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return panel.slice(panel.lastIndexOf("<li>", at), panel.indexOf("</li>", at));
    };

    claimRun(app.db, deployRun.id);
    putEnv(record, env, {
      deploying: {
        run: { id: deployRun.id, commitOid: pull.headOid },
        abort: new AbortController(),
      },
    });
    const deploying = rowOf(
      await (await get("/alice/vault/app/state", owner)).text(),
    );
    expect(deploying).toContain(open);
    expect(deploying).toContain(runLink);
    expect(deploying).toContain("deploy in progress");
    expect(deploying).not.toContain("after the push");
    expect(deploying).not.toContain("0.0s");

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const servingAt = new Date(Date.parse(createdAt) + 3_400).toISOString();
    putEnv(record, env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt: createdAt,
        manifest: { tty: null },
      },
    });
    const live = rowOf(await (await get("/alice/vault/app/state", owner)).text());
    expect(live).toContain(open);
    expect(live).toContain("live 3.4s after the push");
    expect(live).toContain(pull.headOid.slice(0, 7));
    expect(live).toContain(runLink);
    expect(live).toContain(">live<");
    // The live client keys its announcement on the meta line's first words.
    expect(live).toMatch(new RegExp(`class="row-meta">#${pull.number} Add F ·`));
    // The page's first paint draws the same row.
    expect(await (await get("/alice/vault", owner)).text()).toContain(
      "live 3.4s after the push",
    );

    putEnv(record, env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt: createdAt,
        testsFailed: "2 failing",
        manifest: { tty: null },
      },
    });
    const red = rowOf(await (await get("/alice/vault/app/state", owner)).text());
    expect(red).toContain(open);
    expect(red).toContain(runLink);
    expect(red).toContain("serving · tests failed: 2 failing");
    expect(red).toContain("live 3.4s after the push");
    // One badge, not green, and the row still links to the preview.
    expect(red).toMatch(/data-variant="attn"[^]*?serving · tests failed<\/span/);
    expect(red).not.toContain('data-variant="success"');
    expect(red).not.toContain(">live<");

    putEnv(record, env, {
      deploying: {
        run: { id: deployRun.id, commitOid: pull.headOid },
        abort: new AbortController(),
      },
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt: createdAt,
        manifest: { tty: null },
      },
    });
    const verifying = rowOf(
      await (await get("/alice/vault/app/state", owner)).text(),
    );
    expect(verifying).toContain(open);
    expect(verifying).toContain("serving · verifying</span");
    expect(verifying).not.toContain('data-variant="success"');
    expect(verifying).not.toContain('data-variant="attn"');

    putEnv(record, env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        manifest: { tty: null },
      },
    });
    const unmeasured = rowOf(
      await (await get("/alice/vault/app/state", owner)).text(),
    );
    expect(unmeasured).toContain(open);
    expect(unmeasured).not.toContain("after the");
    expect(unmeasured).not.toContain("0.0s");
  });
});

/**
 * On its own: the slots line counts what the loop counts — the builders —
 * while Now still shows every run in flight, review and plan included.
 */
