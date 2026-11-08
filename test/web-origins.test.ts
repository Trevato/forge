/**
 * Origins on the web surface, driven the way a browser drives it: form posts
 * with a session cookie, redirects followed by hand, and every assertion made
 * against the HTML that actually came back.
 *
 * The adversarial cases carry the weight. A token must never appear in a
 * page. Every new POST must refuse a cross-origin submit. An anonymous
 * visitor must be sent to sign in rather than shown an empty list. And a
 * writer who is not the person who connected the origin must be told why
 * their comment did not go upstream, not silently given a local one.
 */

import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createRepo } from "../src/actions/repos.ts";
import { enableApp } from "../src/actions/apps.ts";
import { createToken } from "../src/actions/users.ts";
import { listOrigins, recordSync } from "../src/core/origins.ts";
import { listPins } from "../src/core/pins.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { firstFetchRetry } from "../src/origins/mirror.ts";
import { advance, createJob, settled } from "../src/origins/jobs.ts";
import { icon } from "../src/web/ui.ts";
import { quietLogs, withoutEnv } from "./helpers/globals.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeOAuth,
} from "./fake-origin.ts";
import { pointAtSprite } from "../src/web/icons.ts";
import { spriteAsset } from "../src/web/asset.ts";
import { adminCookie, seedAdmin } from "./helpers/admin.ts";

quietLogs();

// Every test here drives a real git fetch and renders real pages; on a loaded
// check machine the 5 s default measures the machine, not the code.
setDefaultTimeout(30_000);

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-9f2a";
const PASSWORD = "a-long-web-passphrase";
const CLIENT_ID = "Iv1.forge-web-client";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("origins on the web", () => {
  // Whatever the environment thinks: this suite decides when GitHub is
  // configured, and its first assertion is about it *not* being.
  withoutEnv("FORGE_GITHUB_CLIENT_ID", "FORGE_URL");
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let forgejo: FakeForge;
  let github: FakeForge;
  let ghOauth: FakeOAuth;
  let fjOauth: FakeOAuth;
  let base: string;
  let alice = "";
  let bob = "";
  /** The device-flow pages are hers: five flows in a row, under the connect cap. */
  let carol = "";

  /** A browser request: session cookie, manual redirects, real Origin. */
  const asUser = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(base).origin);
    return fetch(`${base}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };

  const signUp = async (username: string): Promise<string> => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-weborigins-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-webupstream-"));

    // A second real forge, so the mirror's git fetch speaks real smart HTTP.
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, {
      username: ORIGIN_LOGIN,
      email: "octo@upstream.test",
      password: ORIGIN_TOKEN,
    });
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/widgets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: "# widgets\nhello\n" }],
      }),
    });

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      description: "gears and things",
      cloneUrl: `${originServers.url}/octo/widgets.git`,
      htmlUrl: `${originServers.url}/octo/widgets`,
      defaultBranch: "main",
    });
    state.labels.set("octo/widgets", [{ id: 1, name: "bug", color: "d73a4a" }]);
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        body: "under load",
        user: "mona",
        labels: ["bug"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    fjOauth = newFakeOAuth(CLIENT_ID);
    state.oauth = fjOauth;
    forgejo = serveFakeForge(state);

    const ghState = newFakeState("github", ORIGIN_LOGIN, "unused-pat");
    ghOauth = newFakeOAuth(CLIENT_ID);
    ghState.oauth = ghOauth;
    github = serveFakeForge(ghState);

    app = createApp({ dataDir, port: 0 });
    everyoneIsAMember(app.db);
    servers = await serve(app);
    base = servers.url;
    alice = await adminCookie(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    bob = await signUp("bob");
    carol = await signUp("carol");
    forgetProviders(dataDir);
  });

  afterAll(async () => {
    forgejo.stop();
    github.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  // ---- the empty page, and who may see it ----

  test("an anonymous visitor is sent to sign in, not shown a list", async () => {
    const response = await asUser("", "/settings/origins");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toStartWith("/signin?next=");
  });

  test("the origins page starts empty and offers the three ways in", async () => {
    const html = await (await asUser(alice, "/settings/origins")).text();
    expect(html).toContain("No origins connected");
    expect(html).toContain("Forgejo / Gitea, one click");
    // Another forge leads (#9388); the rest are folded.
    expect(html).toContain("Another forge");
    expect(html.indexOf("Another forge")).toBeLessThan(html.indexOf("A token for GitHub, Forgejo or Gitea"));
    expect(html.indexOf("Another forge")).toBeLessThan(html.indexOf("One-click sign-in"));
    // Drawn with §5's rows and buttons, not the page's own classes.
    for (const gone of ["handoff", "connect-more", "connect-path"]) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain('id="connect-token"');
    expect(html).toContain('action="/settings/origins/token"');
    expect(html).toContain('name="token"');
    expect(html).toContain('action="/settings/origins/oauth"');
    expect(html).toContain("GitHub, one click");
    expect(html).toContain("Needs an app registration on the instance");
    // No GitHub client id is configured yet, so the button is replaced by a
    // hint rather than left there to fail.
    expect(html).toContain("FORGE_GITHUB_CLIENT_ID");
    expect(html).not.toContain('name="kind" value="github"');
    // And it is reachable from the settings nav.
    expect(html).toContain('href="/settings/origins"');
  });

  // ---- the token path ----

  test("the connect rows lead with the caret, and the one-click folds open only once a form was used", async () => {
    const fold = (page: string, id: string) => {
      const m = new RegExp(`<details id="${id}"\\s*(open)?\\s*>\\s*<summary[^>]*>([\\s\\S]*?)</summary>`).exec(page);
      expect(m).not.toBeNull();
      return { open: m![1] === "open", summary: m![2]! };
    };
    const closed = await (await asUser(alice, "/settings/origins")).text();
    const used = await (await asUser(alice, "/settings/origins?host=codeberg.org")).text();
    for (const [id, brand] of [
      ["connect-forge", "globe"],
      ["connect-token", "key"],
      ["connect-github", "github"],
      ["connect-forgejo", "forgejo"],
    ] as const) {
      for (const page of [closed, used]) {
        const { summary } = fold(page, id);
        // The lead is the caret (it is rotated when open); the brand glyph
        // is in the title beside the name.
        const lead = /<span class="row-lead">([\s\S]*?)<\/span>/.exec(summary)![1]!;
        expect(lead).toBe(pointAtSprite(icon("chevronRight").text, spriteAsset().path));
        expect(lead).not.toBe(pointAtSprite(icon(brand).text, spriteAsset().path));
        expect(/<span\s+class="row-title"[^>]*>([\s\S]*?)<\/span\s*>/.exec(summary)![1]).toContain(pointAtSprite(icon(brand).text, spriteAsset().path));
      }
    }
    expect(fold(closed, "connect-forge").open).toBe(true);
    expect(fold(closed, "connect-token").open).toBe(false);
    expect(fold(closed, "connect-github").open).toBe(false);
    expect(fold(closed, "connect-forgejo").open).toBe(false);
    expect(fold(used, "connect-forge").open).toBe(true);
    expect(fold(used, "connect-token").open).toBe(false);
    expect(fold(used, "connect-github").open).toBe(true);
    expect(fold(used, "connect-forgejo").open).toBe(true);
  });

  test("connecting with a token stores it and never echoes it", async () => {
    const posted = await asUser(alice, "/settings/origins/token", {
      form: { host: forgejo.url, token: ORIGIN_TOKEN },
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/settings/origins");

    const html = await (await asUser(alice, "/settings/origins")).text();
    expect(html).toContain(ORIGIN_LOGIN);
    expect(html).toContain("Healthy");
    expect(html).toContain("personal access token");
    // The one thing that must never be on this page.
    expect(html).not.toContain(ORIGIN_TOKEN);

    const stored = listOrigins(app.db, getUserByName(app.db, "alice")!.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.login).toBe(ORIGIN_LOGIN);
  });

  test("an origin whose last sync failed shows the error as a field error on its card", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    recordSync(app.db, id, { at: new Date().toISOString(), error: "upstream said 502" });
    const html = await (await asUser(alice, "/settings/origins")).text();
    expect(html).toMatch(
      /<div class="field mt" data-invalid>\s*<span class="error" role="alert" id="origin-[^"]+-err"\s*>upstream said 502/,
    );
    expect(html).not.toContain("error-note");
    recordSync(app.db, id, { at: new Date().toISOString() });
  });

  test("a bad token comes back inline with the host preserved and no secret", async () => {
    const response = await asUser(alice, "/settings/origins/token", {
      form: { host: forgejo.url, token: "not-the-right-token" },
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("refused by the origin");
    expect(html).toMatch(/class="error"[^>]*>[^<]*refused by the origin/);
    expect(html).not.toContain("error-note");
    expect(html).toContain(forgejo.url);
    expect(html).not.toContain("not-the-right-token");
  });

  test("a job page streams and refreshes only while the job runs; a failed one stands, with the reason and a retry", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const running = createJob(id, "octo/still-going");
    const live = await (
      await asUser(alice, `/settings/origins/${id}/mirror/${running.id}`)
    ).text();
    expect(live).toContain(
      `data-stream="/api/v1/user/origins/${id}/mirror/${running.id}/stream"`,
    );
    expect(live).not.toContain("http-equiv");
    expect(live).toContain(">Reload</a>");
    advance(running.id, {
      stage: "failed",
      detail: "",
      error:
        "Fetching from the origin failed: fatal: could not read from remote repository",
    });
    const failed = await (
      await asUser(alice, `/settings/origins/${id}/mirror/${running.id}`)
    ).text();
    expect(failed).toContain('data-stream=""');
    expect(failed).not.toMatch(/<meta[^>]*http-equiv="refresh"/);
    expect(failed).toContain("Fetching from the origin failed");
    expect(failed).toContain("Retry");
  });

  test("another user cannot see or act on that origin", async () => {
    const html = await (await asUser(bob, "/settings/origins")).text();
    expect(html).toContain("No origins connected");
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const stolen = await asUser(bob, `/settings/origins/${id}/repos`);
    expect(stolen.status).toBe(404);
  });

  // ---- the picker and mirroring ----

  test("the picker lists the origin's repos and every row opens live", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const html = await (
      await asUser(alice, `/settings/origins/${id}/repos`)
    ).text();
    expect(html).toContain("octo/widgets");
    expect(html).toContain("gears and things");
    expect(html).toContain("Mirror");
    // Enter on a row browses it; mirroring is the secondary verb beside it.
    expect(html).toContain(`href="/origins/${id}/r/octo/widgets"`);
    expect(html).toContain("read it live");
    // No "mirror everything" anywhere on the page.
    expect(html).not.toContain("Mirror all");
  });

  test("the origin row and the mirror forms are drawn with the design's row and default inputs", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const old = /origin-row|origin-name|origin-mark|mirror-form/;
    const card = await (await asUser(alice, "/settings/origins")).text();
    expect(card).not.toMatch(old);
    expect(card).toContain('class="list setting-list"');
    expect(card).toContain("personal access token");
    expect(card).toContain(`action="/settings/origins/${id}/sync"`);
    expect(card).toContain(`href="/settings/origins/${id}/repos"`);
    expect(card).toContain(encodeURIComponent(`/settings/origins/${id}/delete`));
    expect(card).toContain("Sync now");
    expect(card).toContain("Repositories");
    expect(card).toContain("Disconnect");
    const html = await (
      await asUser(alice, `/settings/origins/${id}/repos`)
    ).text();
    expect(html).not.toMatch(old);
    expect(html).toContain('class="row-fields"');
    expect(html).toContain(`action="/settings/origins/${id}/mirror"`);
    expect(html).toContain('name="fullName"');
    expect(html).toContain("Mirror");
    for (const page of [card, html])
      for (const input of page.match(/<input\b[^>]*>/g) ?? [])
        expect(input).not.toContain("data-size");
  });

  test("a remote whose name is taken locally gets the labelled name box in a row-fields form", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const old = /origin-row|origin-name|origin-mark|mirror-form/;
    // A remote whose name is already taken locally gets the labelled name box.
    const alicia = getUserByName(app.db, "alice")!;
    const taken = await createRepo(app, alicia, {
      name: "gadgets",
      visibility: "private",
    });
    expect(taken.ok).toBe(true);
    forgejo.state.repos.push({
      id: 42,
      fullName: "octo/gadgets",
      description: "",
      cloneUrl: `${originServers.url}/octo/gadgets.git`,
      htmlUrl: `${originServers.url}/octo/gadgets`,
      defaultBranch: "main",
    });
    const picker = await (
      await asUser(alice, `/settings/origins/${id}/repos?refresh=1`)
    ).text();
    forgejo.state.repos.pop();
    // Refresh again so the cached repository list forgets the fixture.
    await asUser(alice, `/settings/origins/${id}/repos?refresh=1`);
    expect(picker).not.toMatch(old);
    expect(picker).not.toContain("filters");
    expect(picker).toMatch(
      new RegExp(`<form class="bar mb" method="get" action="/settings/origins/${id}/repos">`),
    );
    expect(picker).toContain('name="q"');
    expect(picker).toContain("Refresh from origin");
    const mirrorForm = `<form[^>]*class="row-fields"[^>]*action="/settings/origins/${id}/mirror"`;
    expect(picker).toMatch(new RegExp(mirrorForm));
    expect(picker).toContain('name="fullName"');
    expect(picker).toMatch(
      /<label for="mirror-name-[^"]+">Local name<\/label>/,
    );
    expect(picker).toContain("Mirror");
  });

  test("Mirror starts a job, shows its stages, and lands on the mirror", async () => {
    // The first fetch is retried on the forge's clock (2 s, 5 s, 10 s); a
    // loaded check machine can spend all three and fail the job. Retry on a
    // short clock instead, so the verdict is the mirror's, not the load's.
    const found = firstFetchRetry.ms;
    firstFetchRetry.ms = Array.from({ length: 40 }, () => 250);
    try {
      await mirrorStartsAJob();
    } finally {
      firstFetchRetry.ms = found;
    }
  });

  async function mirrorStartsAJob(): Promise<void> {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const mirrored = await asUser(alice, `/settings/origins/${id}/mirror`, {
      form: { fullName: "octo/widgets" },
    });
    expect(mirrored.status).toBe(303);
    const jobPath = mirrored.headers.get("location") ?? "";
    expect(jobPath).toStartWith(`/settings/origins/${id}/mirror/`);

    // The job page renders the checklist, and works with no JavaScript: a
    // meta refresh keeps it current while the mirror is still running.
    // A job nothing drives stays running, so the page cannot race the mirror.
    const pending = createJob(id, "octo/pending");
    const running = await (
      await asUser(alice, `/settings/origins/${id}/mirror/${pending.id}`)
    ).text();
    expect(running).toContain("Creating the repository");
    expect(running).toContain("Importing issues");
    expect(running).toContain('id="stages"');
    advance(pending.id, { stage: "failed", detail: "test over" });

    const jobId = jobPath.split("/").pop()!;
    const done = await settled(jobId);
    expect(done?.stage).toBe("done");
    expect(getRepo(app.db, "alice", "widgets")).toBeDefined();

    // Finished: no self-refresh loop, a redirect to the mirror instead.
    const after = await (await asUser(alice, jobPath)).text();
    expect(after).not.toContain("http-equiv");
    expect(after).toContain("Open the mirror");
  }

  test("a running job's stream sends the next stage, then done with the mirror's address; only its starter may read it", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const job = createJob(id, "octo/streamed");
    const path = `/api/v1/user/origins/${id}/mirror/${job.id}/stream`;
    expect((await asUser(bob, path)).status).toBe(404);
    expect((await asUser("", path)).status).toBeGreaterThanOrEqual(401);

    const response = await asUser(alice, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const until = async (needle: string) => {
      while (!seen.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
    };
    await until("event: mirror.creating");
    advance(job.id, { stage: "fetching", detail: "objects" });
    await until("event: mirror.fetching");
    advance(job.id, { stage: "done", detail: "", repo: getRepo(app.db, "alice", "widgets")! });
    await until("event: mirror.done");
    await reader.cancel();
    expect(seen).toContain("event: mirror.fetching");
    expect(seen).toContain('"name":"widgets"');
    expect(seen.indexOf("mirror.fetching")).toBeLessThan(seen.indexOf("mirror.done"));
  });

  test("the repo header wears the where strip and the About rail one block", async () => {
    const html = await (await asUser(alice, "/alice/widgets")).text();
    // Three places, in order, with the workbench as the one being read.
    expect(html).toContain('class="where"');
    expect(html).toContain("mirrored from octo/widgets");
    expect(html).toContain("workbench");
    expect(html).toContain("this machine");
    expect(html).toContain(`${originServers.url}/octo/widgets`);
    // Origin, last fetch, sync and where pushes go are one block now.
    expect(html).toContain("Where it lives");
    expect(html).toContain("Last fetch");
    expect(html).toContain("Sync now");
    expect(html).toContain("Pushes here go through to");
    expect(html).not.toMatch(/class="about"/);
    // The facts render as `dl` rows inside a labelled complementary landmark.
    expect(html).toContain('<aside aria-label="About">');
    expect(html).toMatch(/<dt>Visibility<\/dt>/);
  });

  test("an imported issue shows the origin's author, not the local one", async () => {
    const html = await (await asUser(alice, "/alice/widgets/issues")).text();
    expect(html).toContain("The gear slips");
    expect(html).toContain("mona");
    const page = await (await asUser(alice, "/alice/widgets/issues/7")).text();
    expect(page).toContain("mona");
    expect(page).toContain("view on origin");
    // §5's muted small text, not the retired .origin-link.
    expect(page).not.toContain("origin-link");
    expect(page).toMatch(
      /<a class="bar muted small" href="[^"]+" rel="noreferrer noopener"/,
    );
  });

  test("commenting on a mirrored issue goes through to the origin", async () => {
    const before = forgejo.state.requests.length;
    const posted = await asUser(alice, "/alice/widgets/issues/7/comments", {
      form: { body: "from the web" },
    });
    expect(posted.status).toBe(303);
    const wrote = forgejo.state.requests
      .slice(before)
      .some(
        (r) =>
          r.method === "POST" &&
          r.path.endsWith("/issues/7/comments") &&
          r.body.includes("from the web"),
      );
    expect(wrote).toBe(true);
    const html = await (await asUser(alice, "/alice/widgets/issues/7")).text();
    expect(html).toContain("from the web");
  });

  test("a writer who is not the origin's owner is told why, and nothing is written", async () => {
    const before = forgejo.state.requests.length;
    const posted = await asUser(bob, "/alice/widgets/issues/7/comments", {
      form: { body: "bob was here" },
    });
    expect(posted.status).toBe(303);
    const flash = posted.headers.get("set-cookie") ?? "";
    expect(decodeURIComponent(flash)).toContain(
      "Only the person who connected this origin",
    );
    expect(
      forgejo.state.requests.slice(before).some((r) => r.method === "POST"),
    ).toBe(false);
  });

  test("a mirrored pull's merge box points at the origin", async () => {
    // The mirror has no pull, so assert the state machine directly: a merge
    // POST on a mirror is refused with the origin's own wording.
    const html = await (await asUser(alice, "/alice/widgets/issues/7")).text();
    // Closing goes through the same twin, and the origin sees it.
    const before = forgejo.state.requests.length;
    await asUser(alice, "/alice/widgets/issues/7/state", {
      form: { state: "closed" },
    });
    expect(
      forgejo.state.requests
        .slice(before)
        .some((r) => r.method === "PATCH" || r.method === "POST"),
    ).toBe(true);
    expect(html).toContain("The gear slips");
  });

  // ---- pins ----

  test("the pin toggle round-trips and the home lists what is pinned", async () => {
    const aliceId = getUserByName(app.db, "alice")!.id;
    const pinned = await asUser(alice, "/alice/widgets/pin", {
      form: { pinned: "1" },
    });
    expect(pinned.status).toBe(303);
    expect(listPins(app.db, aliceId)).toHaveLength(1);

    // A mirrored, pinned row separates its two places with `.sep`, not `.where-sep`.
    const originId = listOrigins(app.db, aliceId)[0]!.id;
    const picker = await (await asUser(alice, `/settings/origins/${originId}/repos`)).text();
    expect(picker).not.toContain("where-sep");
    expect(picker).toContain('<span class="sep" aria-hidden="true">·</span');
    expect(picker).toContain("mirrored as");
    expect(picker).toContain("this machine");

    const dash = await (await asUser(`${alice}; forge_mode=dev`, "/feed")).text();
    expect(dash).toContain("On your machine");
    expect(dash).toContain("forge sync");
    expect(dash).toContain('href="/alice/widgets"');
    // The pin card says where each repo lives, and offers the way back out.
    expect(dash).toContain("Unpin");

    const off = await asUser(alice, "/alice/widgets/pin", {
      form: { pinned: "0" },
    });
    expect(off.status).toBe(303);
    expect(listPins(app.db, aliceId)).toHaveLength(0);
  });

  // ---- the device grant ----

  test("an unconfigured GitHub says how to configure it, in three steps", async () => {
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    const page = await (await asUser(bob, "/settings/origins")).text();
    expect(page).toContain("github.com/settings/developers");
    expect(page).toContain("Enable Device Flow");
    expect(page).toContain("FORGE_GITHUB_CLIENT_ID=&lt;client id&gt;");
    expect(page).toContain("FORGE_GITHUB_CLIENT_SECRET");
    expect(page).toContain(`${new URL(base).origin}/settings/origins/callback`);
    // And the fallback that needs no registration is still offered.
    expect(page).toContain("personal access token");
  });

  test("the device flow shows the code and the poll route completes it", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    const started = await asUser(carol, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location") ?? "";
    expect(where).toStartWith("/settings/origins/flows/");

    const page = await (await asUser(carol, where)).text();
    expect(page).toContain("WXYZ-1234");
    expect(page).toContain(ghOauth.verificationUri);
    // The no-JavaScript half is on the page, and says so.
    expect(page).toContain("Check again");
    expect(page).toContain("Refresh this page to check again");
    // The device code itself never crosses to the browser.
    expect(page).not.toContain(ghOauth.deviceCode);

    // Still pending: the poll comes back to the same page.
    const pending = await asUser(carol, `${where}/poll`, { form: {} });
    expect(pending.status).toBe(303);
    expect(pending.headers.get("location")).toBe(where);

    // The human approves on the other device.
    ghOauth.approved = true;
    const done = await asUser(carol, `${where}/poll`, { form: {} });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings/origins?connected=1");

    const landing = await (
      await asUser(carol, "/settings/origins?connected=1")
    ).text();
    expect(landing).toContain("Origin connected.");
    expect(landing).toContain("OAuth");
  });

  /**
   * The flow page has to work for someone whose browser is a phone across
   * the room. Everything that gets it there is asserted here: the QR, the
   * short link, a copy control beside each thing worth copying, and an open
   * link that cannot hand the other tab a handle back into this session.
   */
  test("the flow page carries a QR, a short link, copy buttons and a safe open link", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    const started = await asUser(carol, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    const where = started.headers.get("location") ?? "";
    const page = await (await asUser(carol, where)).text();

    // The QR is inline SVG: no request, no dependency, and dark-on-light
    // whatever the theme is doing around it.
    expect(page).toContain('shape-rendering="crispEdges"');
    expect(page).toContain('fill="#ffffff"');
    expect(page).toContain("<path");
    // The short link, built from the forge's own base URL.
    const short = /http:\/\/[^"<\s]+\/go\/[0-9a-z]{10}/.exec(page);
    expect(short).not.toBeNull();
    expect(short![0]).toStartWith(new URL(base).origin);
    // Copy affordances beside the code and beside each link.
    expect(page).toContain('data-copy="device-code"');
    expect(page).toContain('data-copy="flow-short"');
    expect(page).toContain('data-copy="flow-url"');
    for (const gone of ["handoff", "connect-more", "connect-path"]) {
      expect(page).not.toContain(gone);
    }
    // Values and their copy buttons sit outside the ellipsizing `.row-title`,
    // in a list whose rows wrap.
    expect(page).toContain('class="list setting-list');
    for (const id of ["flow-short", "flow-url"]) {
      expect(page).toMatch(new RegExp(`row-meta[^>]*>\\s*<span[^>]*id="${id}"`));
    }
    const titles = [...page.matchAll(/<span\s+class="row-title"[^>]*>([\s\S]*?)<\/span\s*>/g)];
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t[1]).not.toContain("data-copy");
      expect(t[1]).not.toContain('id="flow-');
    }
    expect(page).toMatch(/row-trail[^>]*>\s*<button[^>]*data-copy="flow-url"/);
    // The QR is capped: no wider than 200 px.
    const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(page)?.[1]);
    expect(width).toBeLessThanOrEqual(200);
    expect(page).toContain("Or open this on a phone:");
    expect(page).toContain("The full link:");
    expect(page).toContain("Open the verification page");
    // Open leaves the forge safely, and the text stays selectable with no JS.
    expect(page).toContain('rel="noopener noreferrer"');
    expect(page).toContain('target="_blank"');
    expect(page).toContain(ghOauth.verificationUri);
  });

  /**
   * The one anonymous route in the origins surface. The phone that types it
   * has never signed in here, and where it lands is a public page — but the
   * code must behave like a secret: unguessable, short-lived, and giving the
   * same answer for "never existed" as for "expired".
   */
  test("/go/:code redirects a signed-out phone, and dead codes are one 404", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    const started = await asUser(carol, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    const where = started.headers.get("location") ?? "";
    const flowId = where.split("/").pop()!;
    const row = app.db
      .query<
        { short_code: string },
        [string]
      >("SELECT short_code FROM oauth_flow WHERE id = ?1")
      .get(flowId)!;
    expect(row.short_code).toMatch(/^[0-9a-z]{10}$/);

    // No cookie at all: this is a different device.
    const logs: string[] = [];
    const wrote = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    const real = { log: console.log, warn: console.warn, error: console.error };
    console.log = wrote;
    console.warn = wrote;
    console.error = wrote;
    let hop: Response;
    try {
      hop = await fetch(`${base}/go/${row.short_code}`, { redirect: "manual" });
    } finally {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    }
    expect(hop.status).toBe(303);
    expect(hop.headers.get("location")).toBe(ghOauth.verificationUri);
    expect(hop.headers.get("cache-control")).toBe("no-store");
    // Where it sends people is a header, never a log line.
    expect(logs.join("\n")).not.toContain(ghOauth.verificationUri);
    expect(logs.join("\n")).not.toContain(row.short_code);

    // A code nobody issued and a flow that has expired are the same answer,
    // byte for byte — anything else tells a guesser which half was right.
    const unknown = await fetch(`${base}/go/zzzzzzzzzz`, {
      redirect: "manual",
    });
    expect(unknown.status).toBe(404);
    const plainBody = await unknown.clone().text();
    expect(plainBody).not.toContain("/search?q=");
    expect(plainBody).not.toContain("Create an account");
    app.db
      .query("UPDATE oauth_flow SET expires_at = ?1 WHERE id = ?2")
      .run("2020-01-01T00:00:00.000Z", flowId);
    const stale = await fetch(`${base}/go/${row.short_code}`, {
      redirect: "manual",
    });
    expect(stale.status).toBe(404);
    // Identical but for the per-response CSP nonce, which every page gets.
    // The code the guesser typed echoes in the page's manifest link (#824):
    // scrub it with the nonce, since both are the visitor's own bytes.
    const sameBut = (text: string): string =>
      text
        .replaceAll(/nonce="[^"]*"/g, 'nonce="N"')
        .replaceAll(/here\?path=[^"&\s]*/g, "here?path=")
        .replaceAll(/next=[^"]*/g, "next=")
        .replaceAll(/\/new\/issue\?from=[^"]*/g, "/new/issue?from=");
    const staleText = await stale.text();
    const unknownText = await unknown.text();
    expect(sameBut(staleText)).toBe(sameBut(unknownText));
    // A dead code offers no sign-in back to itself: it reveals nothing.
    for (const text of [staleText, unknownText]) {
      expect(text).toContain("Go home");
      expect(text).not.toContain("/signin?next=");
    }

    // A finished flow's link dies with it, and the code is not reissued.
    const fresh = await asUser(carol, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    const secondId = (fresh.headers.get("location") ?? "").split("/").pop()!;
    const second = app.db
      .query<
        { short_code: string },
        [string]
      >("SELECT short_code FROM oauth_flow WHERE id = ?1")
      .get(secondId)!;
    expect(second.short_code).not.toBe(row.short_code);
    ghOauth.approved = true;
    await asUser(carol, `/settings/origins/flows/${secondId}/poll`, {
      form: {},
    });
    ghOauth.approved = false;
    const spent = await fetch(`${base}/go/${second.short_code}`, {
      redirect: "manual",
    });
    expect(spent.status).toBe(404);
  });

  test("the poll route answers JSON when asked, for the enhancement", async () => {
    const started = await asUser(carol, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    const where = started.headers.get("location") ?? "";
    const polled = await asUser(carol, `${where}/poll`, {
      form: {},
      headers: { accept: "application/json" },
    });
    expect(polled.status).toBe(200);
    const body = (await polled.json()) as { status: string };
    expect(["pending", "done", "failed"]).toContain(body.status);
  });

  // ---- the Forgejo code flow ----

  test("an unregistered instance shows the exact redirect URI to paste", async () => {
    const started = await asUser(bob, "/settings/origins/oauth", {
      form: { host: forgejo.url },
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location") ?? "";
    expect(where).toContain("register=1");

    const html = await (await asUser(bob, where)).text();
    expect(html).toContain("/user/settings/applications");
    expect(html).toContain(`${new URL(base).origin}/settings/origins/callback`);
    expect(html).toContain("public client is fine");
    expect(html).toContain("Client ID");
  });

  test("a forge that does not know its own URL says so instead of guessing", async () => {
    // The request's Host header is not evidence: this one claims a hostname
    // the operator never vouched for, so the code flow has no callback URI to
    // register and must say why rather than register the caller's guess.
    const page = await fetch(`${base}/settings/origins`, {
      headers: { cookie: alice, host: "forge.example" },
      redirect: "manual",
    });
    const html = await page.text();
    expect(html).toContain("does not know its own public URL");
    expect(html).toContain("FORGE_URL");
    // Configuration guidance, not a failed input: a muted note, never an alert.
    expect(html).toMatch(/<p class="muted small" id="origin-callback-note">/);
    expect(html).not.toContain("error-note");
    expect(html).not.toContain("origin-callback-err");
    // The token path is unaffected, and still offered.
    expect(html).toContain("Another forge");

    const started = await fetch(`${base}/settings/origins/oauth`, {
      method: "POST",
      headers: {
        cookie: alice,
        host: "forge.example",
        origin: "http://forge.example",
      },
      body: new URLSearchParams({ host: forgejo.url }),
      redirect: "manual",
    });
    expect(started.status).toBe(422);
    expect(await started.text()).toContain("FORGE_URL");
  });

  test("registering an app then authorizing sends a PKCE challenge", async () => {
    const registered = await asUser(bob, "/settings/origins/apps", {
      form: { host: forgejo.url, clientId: CLIENT_ID },
    });
    expect(registered.status).toBe(303);

    const page = await (
      await asUser(
        bob,
        `/settings/origins?host=${encodeURIComponent(forgejo.url)}`,
      )
    ).text();
    expect(page).toContain("Authorize");
    expect(page).toContain(CLIENT_ID);

    const started = await asUser(bob, "/settings/origins/oauth", {
      form: { host: forgejo.url },
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location") ?? "";
    const flow = await (await asUser(bob, where)).text();
    expect(flow).toContain("code_challenge=");
    expect(flow).toContain("code_challenge_method=S256");
    expect(flow).toContain("Continue to the instance");
  });

  // ---- CSRF ----

  test("every new POST refuses a cross-origin submit", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const routes: [string, Record<string, string>][] = [
      ["/settings/origins/token", { host: forgejo.url, token: "x" }],
      ["/settings/origins/oauth", { kind: "github" }],
      ["/settings/origins/apps", { host: forgejo.url, clientId: "x" }],
      [`/settings/origins/${id}/sync`, {}],
      [`/settings/origins/${id}/mirror`, { fullName: "octo/widgets" }],
      [`/settings/origins/${id}/delete`, {}],
      ["/alice/widgets/pin", { pinned: "1" }],
      ["/alice/widgets/sync", {}],
    ];
    for (const [path, form] of routes) {
      const response = await asUser(alice, path, {
        form,
        origin: "https://evil.example",
      });
      expect(`${path}:${response.status}`).toBe(`${path}:403`);
    }
  });

  test("an rw token cannot even enumerate the origins a session can", async () => {
    const user = getUserByName(app.db, "alice")!;
    const rw = createToken(app, user, "laptop", "rw");
    const admin = createToken(app, user, "deploy", "admin");
    if (!rw.ok || !admin.ok) throw new Error("token mint failed");
    const id = listOrigins(app.db, user.id)[0]!.id;

    for (const path of ["/settings/origins", `/settings/origins/${id}/repos`]) {
      const denied = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${rw.value.token}` },
        redirect: "manual",
      });
      expect(`${path}:${denied.status}`).toBe(`${path}:403`);
      // An explicit admin token is the documented way in for automation.
      const allowed = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${admin.value.token}` },
        redirect: "manual",
      });
      expect(`${path}:${allowed.status}`).toBe(`${path}:200`);
    }

    // And it cannot spend one either.
    const write = await fetch(`${base}/settings/origins/${id}/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rw.value.token}`,
        origin: new URL(base).origin,
      },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(write.status).toBe(403);
  });

  // ---- studio mode on a mirrored app (#281) ----

  test("in studio mode, a mirrored app says where it reads from in one line, never dev's where strip", async () => {
    const aliceUser = getUserByName(app.db, "alice")!;
    const repo = getRepo(app.db, "alice", "widgets")!;
    const enabled = enableApp(app, aliceUser, repo, { slug: "widgets" });
    expect(enabled.ok).toBe(true);

    const studioHtml = await (
      await asUser(`${alice}; forge_mode=studio`, "/alice/widgets")
    ).text();
    expect(studioHtml).not.toContain('class="where"');
    expect(studioHtml).not.toContain("workbench");
    expect(studioHtml).not.toContain("this machine");
    // Still says where it is read from, and when it last synced — in one
    // line, the studio's own words rather than dev's three-place strip.
    expect(studioHtml).toContain(`${originServers.url}/octo/widgets`);
    expect(studioHtml).toContain("synced");

    // An old dev cookie changes nothing (#603): the same one line. dev's
    // three-place strip is the code's, on the Files step.
    const devHtml = await (
      await asUser(`${alice}; forge_mode=dev`, "/alice/widgets")
    ).text();
    expect(devHtml).not.toContain('class="where"');
    expect(devHtml).toContain("synced");
  });

  test("disconnecting is confirmed on a page that says what it costs", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const confirm = await asUser(
      alice,
      `/-/confirm?to=${encodeURIComponent(`/settings/origins/${id}/delete`)}`,
    );
    expect(confirm.status).toBe(200);
    const html = await confirm.text();
    expect(html).toContain("Disconnect this origin?");
    expect(html).toContain("revoked upstream only where the forge allows it");

    const gone = await asUser(alice, `/settings/origins/${id}/delete`, {
      form: {},
    });
    expect(gone.status).toBe(303);
    // The mirror survives the disconnect; it simply stops syncing.
    expect(getRepo(app.db, "alice", "widgets")).toBeDefined();
  });
});
