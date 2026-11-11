/**
 * The workflow units, in a browser.
 *
 * The owner's ask was that the units be first class: *grab my repo, clone,
 * branch, edit, PR* — and then the other half of that loop, *review it,
 * settle the threads, and let the gate decide whether it merges*. Every one
 * of those is a page with a form on it, so every one of them is tested here
 * the way a person meets it: fetch the page, read the words, post the form,
 * follow the redirect.
 *
 * Two halves, because they need different worlds.
 *
 * The fork half runs against **two real forges plus a fake API**: the fake is
 * the origin's control plane, the second `forge` is the git host its clone
 * URLs point at, so a fork is a repository that exists and a push is a push.
 * A stubbed provider would prove nothing about the interesting parts — the
 * fork that is not there yet, the branch that must start from the upstream,
 * the `owner:branch` head form.
 *
 * The review half runs against one forge and no network at all, because
 * verdicts, threads and the merge gate are entirely ours.
 *
 * The adversarial assertions carry the weight in both: every new POST must
 * refuse a cross-origin form, an anonymous visitor must be sent to sign in
 * rather than shown a button that 403s, an author must not be able to
 * approve their own change, and every page must render with no JavaScript.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listOrigins, repoForkOf } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { settled } from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { clearViewCache } from "../src/view/cache.ts";
import { quietLogs } from "./helpers/globals.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

// A mirror job clones over git; a loaded check machine needs more than bun's
// 5 s default. The wait is on the job reaching a terminal stage, not on time.
const JOB_TIMEOUT_MS = 60_000;

quietLogs();

const PASSWORD = "a-long-workflow-passphrase";

/**
 * A page with its whitespace collapsed, for asserting on a *sentence*.
 *
 * The markup is formatted, so a phrase in the source can arrive with a
 * newline and eight spaces in the middle of it. That is invisible to a
 * reader and irrelevant to the claim being made, so it is normalised away
 * rather than encoded into the assertion.
 */
const words = (html: string): string => html.replace(/\s+/g, " ");

/** Anything that would need a script to work. */
function assertNoScriptDependence(html: string): void {
  // The shell ships one nonce'd script; nothing on these pages may *depend*
  // on it, which is what "renders without JS" means here.
  expect(html).not.toContain("onclick=");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("</form>");
}

// ────────────────────────────────────────────────────────────────────────
describe("fork at the origin, and propose a change through it", () => {
  let dataDir = "";
  let upDataDir = "";
  let app: App;
  let servers: Servers;
  let upApp: App;
  let upServers: Servers;
  let fake: FakeForge;
  let base = "";
  let alice = "";
  let originId = "";
  let browse = "";
  let ownBrowse = "";
  const ORIGIN_LOGIN = "me";

  const basic = (user: string, secret: string): string =>
    `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

  const web = (
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

  const bodyOf = async (cookie: string, path: string): Promise<string> => {
    const response = await web(cookie, path);
    expect(`${path} → ${response.status}`).toBe(`${path} → 200`);
    return response.text();
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
    proveAll(app);
    promote(app.db);
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  /** An account on the upstream forge, and an admin token for it. */
  async function upstreamAccount(username: string): Promise<string> {
    await fetch(`${upServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@up.test`,
        password: PASSWORD,
      }),
    });
    proveAll(upApp);
    promote(upApp.db);
    return tokenFor(upApp, username, "admin");
  }

  const upstream = (
    path: string,
    init: RequestInit & { as?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(init.as ?? "octo", PASSWORD));
    return fetch(`${upServers.url}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wf-"));
    upDataDir = await mkdtemp(join(tmpdir(), "forge-wf-up-"));

    upApp = createApp({ dataDir: upDataDir, port: 0 });
    upServers = await serve(upApp);
    await upstreamAccount("octo");
    const originToken = await upstreamAccount(ORIGIN_LOGIN);

    for (const [owner, name] of [
      ["octo", "gears"],
      [ORIGIN_LOGIN, "own"],
    ] as const) {
      await upstream("/api/v1/repos", {
        as: owner,
        method: "POST",
        body: JSON.stringify({ name, visibility: "public" }),
      });
      await upstream(`/api/v1/repos/${owner}/${name}/contents`, {
        as: owner,
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          message: "first",
          files: [
            { path: "a.txt", content: "one\n" },
            { path: "README.md", content: `# ${name}\n` },
          ],
        }),
      });
    }
    // `me` really has a fork of octo/gears on the upstream forge, so the
    // clone URL the fake hands back for it is a repository that exists and
    // that `me` may push to.
    expect(
      (
        await upstream("/api/v1/repos/octo/gears/forks", {
          as: ORIGIN_LOGIN,
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(201);

    const state = newFakeState("forgejo", ORIGIN_LOGIN, originToken);
    state.repos.push(
      {
        id: 1,
        fullName: "octo/gears",
        description: "gears and things",
        cloneUrl: `${upServers.url}/octo/gears.git`,
        htmlUrl: `${upServers.url}/octo/gears`,
        defaultBranch: "main",
        // The premise of the whole flow: this account cannot push here.
        push: false,
        admin: false,
      },
      {
        id: 2,
        fullName: `${ORIGIN_LOGIN}/own`,
        cloneUrl: `${upServers.url}/${ORIGIN_LOGIN}/own.git`,
        htmlUrl: `${upServers.url}/${ORIGIN_LOGIN}/own`,
        defaultBranch: "main",
        push: true,
        admin: true,
      },
    );
    state.files.set(
      "octo/gears",
      new Map([
        ["a.txt", "one\n"],
        ["README.md", "# gears\n"],
      ]),
    );
    state.files.set(
      `${ORIGIN_LOGIN}/own`,
      new Map([
        ["a.txt", "one\n"],
        ["README.md", "# own\n"],
      ]),
    );
    for (const name of ["octo/gears", `${ORIGIN_LOGIN}/own`])
      state.branches.set(name, [{ name: "main", sha: "a".repeat(40) }]);
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    alice = await signUp("alice");
    forgetProviders(dataDir);
    const connected = await web(alice, "/settings/origins/token", {
      form: { host: fake.url, token: originToken },
    });
    expect(connected.status).toBe(303);
    originId = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    browse = `/origins/${originId}/r/octo/gears`;
    ownBrowse = `/origins/${originId}/r/${ORIGIN_LOGIN}/own`;
    clearViewCache();
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    upServers.stop();
    app.close();
    upApp.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(upDataDir, { recursive: true, force: true });
  });

  // ---- 1. fork ----

  test("a live browse offers Fork, and the picker row does too", async () => {
    const page = await bodyOf(alice, browse);
    expect(page).toContain(`action="${browse}/fork"`);
    expect(page).toContain(">Fork");
    assertNoScriptDependence(page);

    const picker = await bodyOf(alice, `/settings/origins/${originId}/repos`);
    expect(picker).toContain(`action="${browse}/fork"`);
    // Not on a repository the connected account already owns — neither
    // forge forks you to yourself.
    expect(picker).not.toContain(`action="${ownBrowse}/fork"`);
  });

  test("Fork lands on the job, then on the fork's mirror saying whose it is", async () => {
    const forked = await web(alice, `${browse}/fork`, { form: {} });
    expect(forked.status).toBe(303);
    const to = forked.headers.get("location") ?? "";
    expect(to).toStartWith(`/settings/origins/${originId}/mirror/`);
    // The flash rides the redirect and names both halves and the host.
    const cookie = forked.headers.get("set-cookie") ?? "";
    const flash = decodeURIComponent(
      /forge_flash=([^;]*)/.exec(cookie)?.[1] ?? "",
    );
    expect(flash).toContain("Forked octo/gears to me/gears");
    expect(flash).toContain(new URL(fake.url).host);

    const jobId = to.split("/").pop()!;
    const done = await settled(jobId);
    expect(done?.stage).toBe("done");
    const mirror = done?.repo;
    expect(mirror).toBeDefined();

    // The mirror knows it is a fork, and says so on its own pages.
    expect(repoForkOf(app.db, mirror!.id)).toBe("octo/gears");
    const page = await bodyOf(alice, `/${mirror!.ownerName}/${mirror!.name}`);
    expect(page).toContain("fork of");
    expect(page).toContain("octo/gears");
    // Both places: the header's where-strip and the About rail.
    expect(words(page)).toContain("fork of octo/gears");
    expect(page).toContain(`href="${browse}"`);
  }, JOB_TIMEOUT_MS);

  test("forking again is idempotent and lands straight on the mirror", async () => {
    const before = fake.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/gears/forks"),
    ).length;
    const again = await web(alice, `${browse}/fork`, { form: {} });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/alice/gears");
    const after = fake.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/gears/forks"),
    ).length;
    expect(after).toBe(before);
  });

  test("Fork refuses a cross-origin form and sends an anonymous visitor to sign in", async () => {
    const forged = await web(alice, `${browse}/fork`, {
      form: {},
      origin: "https://evil.example",
    });
    expect(forged.status).toBe(403);

    const anon = await web("", `${browse}/fork`, { form: {} });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/signin");
  });

  // ---- 2. propose a change ----

  test("no push rights turns Edit into Propose a change, and says where it lands", async () => {
    const file = await bodyOf(alice, `${browse}/blob/main/a.txt`);
    expect(file).toContain("Propose a change");
    expect(file).toContain(`${browse}/edit/main/a.txt`);

    const editor = await bodyOf(alice, `${browse}/edit/main/a.txt`);
    assertNoScriptDependence(editor);
    // The sentence, with both repository names in it.
    expect(words(editor)).toContain("This lands on your fork");
    expect(editor).toContain("me/gears");
    expect(words(editor)).toContain("opens a pull on");
    expect(editor).toContain("octo/gears");
    // A branch name, a pull title and a pull body — and no way to commit
    // straight onto the upstream, because there is no such option.
    expect(editor).toContain('name="branch"');
    expect(editor).toContain('name="pullTitle"');
    expect(editor).toContain('name="pullBody"');
    expect(editor).not.toContain("Commit directly to");
    expect(editor).toContain(`action="${browse}/contribute"`);
    expect(editor).toContain("Propose this change");
    // The file's own text is in the textarea, untouched.
    expect(editor).toContain("one");
  });

  test("proposing forks, branches on the fork, and opens the pull upstream", async () => {
    const proposed = await web(alice, `${browse}/contribute`, {
      form: {
        ref: "main",
        path: "a.txt",
        content: "one, fixed\n",
        message: "fix the typo",
        branch: "alice/fix-typo",
        pullTitle: "Fix the typo",
        pullBody: "a small thing",
      },
    });
    expect(proposed.status).toBe(303);
    const to = proposed.headers.get("location") ?? "";
    // No mirror of the UPSTREAM here, so the pull has no local row — the
    // live browse of that pull is where you land, which is still a page in
    // this product rather than a bounce to another forge.
    expect(to).toBe(`${browse}/pulls/1`);
    const flash = decodeURIComponent(
      /forge_flash=([^;]*)/.exec(
        proposed.headers.get("set-cookie") ?? "",
      )?.[1] ?? "",
    );
    expect(flash).toContain("octo/gears#1");

    // The branch really landed on the fork's git.
    const branches = (
      (await (
        await fetch(`${upServers.url}/api/v1/repos/me/gears/branches`)
      ).json()) as { items: { name: string }[] }
    ).items;
    expect(branches.map((b) => b.name)).toContain("alice/fix-typo");

    // And the pull went upstream with the cross-repository head form.
    const opened = fake.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/octo/gears/pulls"),
    );
    expect(opened).toHaveLength(1);
    const sent = JSON.parse(opened[0]!.body) as Record<string, unknown>;
    expect(sent.head).toBe("me:alice/fix-typo");
    expect(sent.base).toBe("main");
    expect(sent.title).toBe("Fix the typo");
    const stored = fake.state.issues.get("octo/gears") ?? [];
    expect(stored[0]?.pull?.headRepo).toBe("me/gears");
    // Fork, clone, commit and push over real git take ~2 s alone, which is
    // over bun's 5 s default once the check machine is loaded (#4232).
  }, 60_000);

  test("a refused proposal re-renders the editor with every word still there", async () => {
    fake.state.refuseWrite = "no pulls today";
    const refused = await web(alice, `${browse}/contribute`, {
      form: {
        ref: "main",
        path: "a.txt",
        content: "a draft nobody wants to retype\n",
        message: "second go",
        branch: "alice/second-go",
        pullTitle: "Second go",
        pullBody: "the body I typed",
      },
    });
    fake.state.refuseWrite = "";
    expect(refused.status).toBe(200);
    const html = await refused.text();
    expect(html).toContain("a draft nobody wants to retype");
    expect(html).toContain("second go");
    expect(html).toContain("the body I typed");
    expect(html).toContain('value="alice/second-go"');
    // A refusal that is the whole form's sits in a danger toast, and no
    // field claims to be invalid.
    expect(html).toMatch(/class="toast" data-tone="danger"/);
    expect(html.match(/class="toast"/g)).toHaveLength(1);
    expect(html).not.toContain("data-invalid");
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("error-note");
  });

  test("a missing commit message or file path is the error of that field", async () => {
    const form = {
      ref: "main",
      path: "a.txt",
      content: "x\n",
      message: "",
      branch: "alice/x",
    };
    const noMessage = await (
      await web(alice, `${browse}/contribute`, { form })
    ).text();
    expect(noMessage).toMatch(
      /<div class="field" data-invalid>[\s\S]*?id="f-message"[^>]*aria-invalid="true"[\s\S]*?class="error"[^>]*>\s*A commit needs a message/,
    );
    expect(noMessage).not.toContain("data-tone=\"danger\"");

    const noPath = await (
      await web(alice, `${browse}/contribute`, {
        form: { ...form, path: "", message: "m", creating: "1" },
      })
    ).text();
    expect(noPath).toMatch(
      /name="path"[^>]*aria-invalid="true"[^>]*aria-describedby="f-path-err"/,
    );
    expect(noPath).toMatch(
      /<span class="error" id="f-path-err">Give the file a path/,
    );
    expect(noPath).not.toContain("error-note");
  });

  test("contribute refuses a cross-origin form, and anonymous is sent to sign in", async () => {
    const forged = await web(alice, `${browse}/contribute`, {
      form: { ref: "main", path: "a.txt", content: "x", message: "m" },
      origin: "https://evil.example",
    });
    expect(forged.status).toBe(403);
    const anon = await web("", `${browse}/contribute`, {
      form: { ref: "main", path: "a.txt", content: "x", message: "m" },
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/signin");
  });

  test("push rights mean the plain editor, not a fork", async () => {
    // `me/own` is mirrored, and the origin says this account may push to it,
    // so the mirror's own editor is the ordinary one.
    const started = await web(alice, `${ownBrowse}/mirror`, { form: {} });
    expect(started.status).toBe(303);
    const jobId = (started.headers.get("location") ?? "").split("/").pop()!;
    const done = await settled(jobId);
    expect(done?.stage).toBe("done");
    const mirror = done!.repo!;
    const editor = await bodyOf(
      alice,
      `/${mirror.ownerName}/${mirror.name}/edit/main/a.txt`,
    );
    expect(editor).toContain("Commit directly to");
    expect(words(editor)).not.toContain("This lands on your fork");
    expect(editor).toContain(
      `action="/${mirror.ownerName}/${mirror.name}/edit"`,
    );
  }, JOB_TIMEOUT_MS);

  test("a mirror of a repository you cannot push to proposes instead", async () => {
    // The fork's mirror (alice/gears) mirrors `me/gears`, which this account
    // owns — so it edits directly. Mirror the UPSTREAM too and that one
    // proposes, because the origin says `push: false` for it.
    const started = await web(alice, `${browse}/mirror`, {
      form: { name: "gears-upstream" },
    });
    expect(started.status).toBe(303);
    const jobId = (started.headers.get("location") ?? "").split("/").pop()!;
    const done = await settled(jobId);
    expect(done?.stage).toBe("done");
    const mirror = done!.repo!;
    const at = `/${mirror.ownerName}/${mirror.name}`;

    const editor = await bodyOf(alice, `${at}/edit/main/a.txt`);
    expect(words(editor)).toContain("This lands on your fork");
    expect(editor).toContain("me/gears");
    expect(editor).not.toContain("Commit directly to");
    expect(editor).toContain(`action="${at}/contribute"`);

    // And now that we DO hold a mirror of the upstream, the pull it opens is
    // imported and shown here rather than only at the origin.
    const proposed = await web(alice, `${at}/contribute`, {
      form: {
        ref: "main",
        path: "a.txt",
        content: "one, fixed again\n",
        message: "third go",
        branch: "alice/third-go",
        pullTitle: "Third go",
      },
    });
    expect(proposed.status).toBe(303);
    expect(proposed.headers.get("location")).toBe(`${at}/pulls/2`);
    expect(getRepo(app.db, mirror.ownerName, mirror.name)).toBeDefined();
  }, JOB_TIMEOUT_MS);
});

// ────────────────────────────────────────────────────────────────────────
describe("verdicts, threads, and the gate they open", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";
  const cookies: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let pullNumber = 0;

  const web = (
    who: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = cookies[who];
    if (cookie !== undefined) headers.set("cookie", cookie);
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

  const bodyOf = async (who: string, path: string): Promise<string> => {
    const response = await web(who, path);
    expect(`${path} → ${response.status}`).toBe(`${path} → 200`);
    return response.text();
  };

  const api = (
    who: string,
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[who]}`,
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

  async function mkUser(username: string): Promise<void> {
    const signed = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@f.dev`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    cookies[username] = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    proveAll(app);
    promote(app.db);
    tokens[username] = tokenFor(app, username, "admin");
  }

  /** The first line of the diff, as a review anchor form would name it. */
  const ANCHOR = { path: "a.txt", side: "new", line: "1" };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wfr-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await mkUser("ada");
    await mkUser("bob");
    await mkUser("cleo");

    // An org, because a repo with one owner cannot express "somebody else
    // approved this": ada administers it, bob is a writer, cleo is neither.
    expect(
      (await api("ada", "POST", "/api/v1/orgs", { name: "acme" })).status,
    ).toBe(201);
    await api("ada", "POST", "/api/v1/orgs/acme/teams", {
      name: "devs",
      permission: "write",
    });
    await api("ada", "POST", "/api/v1/orgs/acme/teams/devs/members", {
      user: "bob",
    });
    expect(
      (
        await api("ada", "POST", "/api/v1/repos", {
          owner: "acme",
          name: "lib",
          visibility: "public",
        })
      ).status,
    ).toBe(201);
    await api("ada", "POST", "/api/v1/repos/acme/lib/contents", {
      branch: "main",
      message: "first",
      files: [{ path: "a.txt", content: "one\n" }],
    });
    const edit = await api("ada", "POST", "/api/v1/repos/acme/lib/edits", {
      newBranch: "fix",
      base: "main",
      message: "fix it",
      files: [{ path: "a.txt", content: "one, fixed\n" }],
      openPull: { title: "Fix it" },
    });
    expect(edit.status).toBe(201);
    pullNumber = ((await edit.json()) as { pull: { number: number } }).pull
      .number;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const at = (): string => `/acme/lib/pulls/${pullNumber}`;
  // The review card, the merge box and the diff's threads are the change's
  // Files step, one tab under the change.
  const files = (): string => `${at()}/files`;

  // ---- the review card ----

  test("the pull page carries a review card with the verdicts you may pass", async () => {
    const forBob = await bodyOf("bob", files());
    expect(forBob).toContain(`action="${at()}/review-state"`);
    expect(forBob).toContain(">Approve");
    expect(forBob).toContain(">Request changes");
    expect(forBob).toContain(">Comment");
    assertNoScriptDependence(forBob);

    // The author never sees Approve — you cannot approve your own change.
    const forAda = await bodyOf("ada", files());
    expect(forAda).not.toContain(">Approve");
    expect(words(forAda)).toContain("cannot approve your own pull request");

    // A reader may only comment: a verdict that gates a merge is a writer's.
    const forCleo = await bodyOf("cleo", files());
    expect(forCleo).not.toContain(">Approve");
    expect(forCleo).not.toContain(">Request changes");
    expect(forCleo).toContain(">Comment");

    // Anonymous is asked to sign in rather than shown a button that 403s.
    const forNobody = await bodyOf("nobody", files());
    expect(words(forNobody)).toContain("to review this change");
    expect(forNobody).not.toContain(`action="${at()}/review-state"`);
  });

  test("an author's approval is refused by the server too, not only hidden", async () => {
    const refused = await web("ada", `${at()}/review-state`, {
      form: { state: "approved", body: "looks good to me" },
    });
    expect(refused.status).toBe(303);
    const flash = decodeURIComponent(
      /forge_flash=([^;]*)/.exec(
        refused.headers.get("set-cookie") ?? "",
      )?.[1] ?? "",
    );
    expect(flash).toContain("cannot approve your own");
    expect(flash).toContain("danger");
  });

  test("a reader cannot request changes, however the form is posted", async () => {
    const refused = await web("cleo", `${at()}/review-state`, {
      form: { state: "changes_requested" },
    });
    expect(refused.status).toBe(303);
    const flash = decodeURIComponent(
      /forge_flash=([^;]*)/.exec(
        refused.headers.get("set-cookie") ?? "",
      )?.[1] ?? "",
    );
    expect(flash).toContain("write access");
  });

  test("verdicts render in the timeline with a badge", async () => {
    const posted = await web("bob", `${at()}/review-state`, {
      form: { state: "changes_requested", body: "the **spec** says 34" },
    });
    expect(posted.status).toBe(303);

    const page = await bodyOf("ada", at());
    expect(words(page)).toContain("Changes requested");
    expect(page).toContain("the <strong>spec</strong> says 34");
    // …and the merge box, on the Files step, names who is blocking it.
    expect(words(await bodyOf("ada", files()))).toContain(
      "changes requested by bob",
    );
  });

  // ---- the gate ----

  test("require-review is a checkbox in general settings, and it sticks", async () => {
    const settings = await bodyOf("ada", "/acme/lib/settings");
    expect(settings).toContain('name="requireReview"');
    expect(words(settings)).toContain("Require an approving review");

    const saved = await web("ada", "/acme/lib/settings", {
      form: {
        description: "",
        visibility: "public",
        defaultBranch: "main",
        requireReview: "on",
      },
    });
    expect(saved.status).toBe(303);
    const again = await bodyOf("ada", "/acme/lib/settings");
    expect(/name="requireReview"[^>]*\schecked/.test(again)).toBe(true);
  });

  test("with a change requested, the merge button is disabled and says why", async () => {
    const page = await bodyOf("ada", files());
    expect(words(page)).toContain("Waiting on review");
    expect(words(page)).toContain("bob asked for changes");
    expect(page).toContain("disabled");
  });

  test("the merge is refused in the action, not only on the button", async () => {
    const refused = await web("ada", `${at()}/merge`, {
      form: { strategy: "merge" },
    });
    expect(refused.status).toBe(303);
    const flash = decodeURIComponent(
      /forge_flash=([^;]*)/.exec(
        refused.headers.get("set-cookie") ?? "",
      )?.[1] ?? "",
    );
    expect(flash).toContain("approving review");
  });

  test("an approval opens the gate, and a later push closes it again", async () => {
    const approved = await web("bob", `${at()}/review-state`, {
      form: { state: "approved" },
    });
    expect(approved.status).toBe(303);

    const ready = await bodyOf("ada", files());
    expect(words(ready)).toContain("Ready to merge");
    expect(words(ready)).toContain("1 approval");
    expect(words(ready)).not.toContain("Waiting on review");

    // A push is new code nobody has looked at: the approval is dismissed.
    const pushed = await api("ada", "POST", "/api/v1/repos/acme/lib/contents", {
      branch: "fix",
      message: "one more thing",
      files: [{ path: "b.txt", content: "two\n" }],
    });
    expect(pushed.status).toBe(201);

    const stale = await bodyOf("ada", files());
    expect(words(stale)).toContain("Waiting on review");
    expect(words(stale)).not.toContain("1 approval");
    // The dismissed verdict reads as history in the change's conversation.
    const timeline = await bodyOf("ada", at());
    expect(words(timeline)).toContain("before the latest push");
    expect(timeline).toContain("verdict-stale");
  });

  test("the pull list shows each pull in its word; where it stands on review is one step deeper, on the change", async () => {
    // One list (#627): a row is the pull's word, never a review badge.
    const list = await bodyOf("ada", "/acme/lib/pulls");
    expect(list).toContain(`href="/acme/lib/pulls/${pullNumber}"`);
    expect(list).toContain("data-word=");
    expect(words(list)).not.toContain("Needs review");

    await web("bob", `${at()}/review-state`, {
      form: { state: "changes_requested" },
    });
    expect(words(await bodyOf("ada", files()))).toContain(
      "changes requested by bob",
    );
    // Put it back so the thread tests below have a sane pull.
    await web("bob", `${at()}/review-state`, { form: { state: "approved" } });
    expect(words(await bodyOf("ada", files()))).toContain("1 approval");
  });

  // ---- threads ----

  test("a review thread can be resolved and reopened, and the count says so", async () => {
    const commented = await web("bob", `${at()}/review`, {
      form: { ...ANCHOR, body: "is this right?" },
    });
    expect(commented.status).toBe(303);

    const open = await bodyOf("ada", files());
    expect(words(open)).toContain("1 thread · 1 unresolved");
    expect(words(open)).toContain("> Resolve <");
    const anchor = /threads\/([0-9a-f]{16})\/resolve/.exec(open)?.[1];
    expect(anchor).toBeDefined();

    const resolved = await web("ada", `${at()}/threads/${anchor}/resolve`, {
      form: {},
    });
    expect(resolved.status).toBe(303);

    const settledPage = await bodyOf("ada", files());
    expect(words(settledPage)).toContain("1 thread · 0 unresolved");
    expect(settledPage).toContain("resolved by");
    expect(settledPage).toContain("ada");
    expect(words(settledPage)).toContain("> Unresolve <");
    // Collapsed behind a disclosure, not deleted.
    expect(settledPage).toContain("<details");
    expect(words(settledPage)).toContain("Show 1 comment");
    expect(settledPage).toContain("is this right?");

    const reopened = await web("bob", `${at()}/threads/${anchor}/unresolve`, {
      form: {},
    });
    expect(reopened.status).toBe(303);
    expect(words(await bodyOf("ada", files()))).toContain("1 thread · 1 unresolved");
  });

  test("a stranger cannot settle somebody else's thread", async () => {
    const page = await bodyOf("ada", files());
    const anchor = /threads\/([0-9a-f]{16})\/resolve/.exec(page)![1]!;
    const refused = await web("cleo", `${at()}/threads/${anchor}/resolve`, {
      form: {},
    });
    expect(refused.status).toBe(303);
    const flash = decodeURIComponent(
      /forge_flash=([^;]*)/.exec(
        refused.headers.get("set-cookie") ?? "",
      )?.[1] ?? "",
    );
    expect(flash).toContain("Only someone in the thread");
    // And cleo is not even offered the button.
    expect(await bodyOf("cleo", files())).not.toContain("/resolve");
  });

  test("every new POST refuses a cross-origin form and an anonymous caller", async () => {
    const page = await bodyOf("ada", files());
    const anchor = /threads\/([0-9a-f]{16})\/resolve/.exec(page)![1]!;
    const routes = [
      `${at()}/review-state`,
      `${at()}/threads/${anchor}/resolve`,
      `${at()}/threads/${anchor}/unresolve`,
      "/acme/lib/settings",
    ];
    for (const route of routes) {
      const forged = await web("ada", route, {
        form: { state: "commented" },
        origin: "https://evil.example",
      });
      expect(`${route} cross-origin → ${forged.status}`).toBe(
        `${route} cross-origin → 403`,
      );
      const anon = await web("nobody", route, { form: { state: "commented" } });
      expect(anon.status).toBeGreaterThanOrEqual(303);
      expect(anon.status).toBeLessThan(405);
    }
  });

  test("an unknown thread anchor is the same 404 as anything else missing", async () => {
    const bogus = await web("ada", `${at()}/threads/notahexdigest/resolve`, {
      form: {},
    });
    expect(bogus.status).toBe(404);
  });
});
