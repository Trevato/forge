/**
 * The web shell and its new affordances, exercised against a real server:
 * flash messages, label assignment, closing a pull, deleting a repository,
 * account forms, the palette index, the raw route, and the boundaries that
 * every one of those has to respect (cross-origin, permission, ref safety).
 *
 * These are protocol-level tests on purpose. The adversarial ones — can a
 * stranger see the Settings tab, can a crafted confirm link aim anywhere, can
 * a bad ref reach git — are worth more than the happy paths beside them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { listLabels, labelsFor, getIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

describe("web ui", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner = "";
  let stranger = "";
  let pullNumber = 0;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Mel",
    GIT_AUTHOR_EMAIL: "mel@forge.local",
    GIT_COMMITTER_NAME: "Mel",
    GIT_COMMITTER_EMAIL: "mel@forge.local",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };

  async function git(args: string[], cwd: string): Promise<number> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  }

  async function signup(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "web-ui-password",
      }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-webui-"));
    work = await mkdtemp(join(tmpdir(), "forge-webui-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    owner = await signup("mel");
    stranger = await signup("kim");

    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "proj", visibility: "public", description: "a repo" }),
      redirect: "manual",
    });

    // A real repository, so tree/blob/raw/commits have something to render.
    const repo = join(work, "proj");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main", "."], repo);
    await writeFile(join(repo, "a.txt"), "one\n");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "first"], repo);
    const remote = `http://mel:web-ui-password@localhost:${servers.port}/mel/proj.git`;
    await git(["push", "-q", remote, "main"], repo);
    await git(["checkout", "-q", "-b", "topic"], repo);
    await writeFile(join(repo, "a.txt"), "two\n");
    await git(["commit", "-qam", "second"], repo);
    await git(["push", "-q", remote, "topic"], repo);

    await fetch(`${base}/mel/proj/issues/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ title: "needs a label", body: "" }),
      redirect: "manual",
    });
    await fetch(`${base}/mel/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "bug", color: "d73a4a" }),
      redirect: "manual",
    });
    const opened = await fetch(`${base}/mel/proj/pulls/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({
        base: "main",
        head: "topic",
        title: "second line",
        body: "",
        baseRepo: "self",
      }),
      redirect: "manual",
    });
    pullNumber = Number(
      (opened.headers.get("location") ?? "").split("/").pop(),
    );
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  // ---- flash ----

  test("a mutation flashes once, and rendering it clears the cookie", async () => {
    const posted = await fetch(`${base}/mel/proj/issues/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ title: "flash me", body: "" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    const setCookie = posted.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("forge_flash=");
    expect(setCookie).toContain("HttpOnly");
    const flash = setCookie.split(";")[0]!;

    const shown = await fetch(`${base}${posted.headers.get("location")}`, {
      headers: { cookie: `${owner}; ${flash}` },
    });
    const html = await shown.text();
    expect(html).toContain('class="toast"');
    expect(html).toContain("opened");
    // Shown exactly once: the page that rendered it also expired the cookie.
    expect(shown.headers.get("set-cookie") ?? "").toContain("forge_flash=;");

    // Without the cookie the same page carries no toast at all.
    const plain = await fetch(`${base}${posted.headers.get("location")}`, {
      headers: { cookie: owner },
    });
    expect(await plain.text()).not.toContain('class="toast"');
  });

  test("a malformed flash cookie is ignored, never rendered", async () => {
    const res = await fetch(base, {
      headers: { cookie: `${owner}; forge_flash=%%%not-json%%%` },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("not-json");
  });

  // ---- labels ----

  test("the labels form applies labels, and they render as chips", async () => {
    const repo = getRepo(app.db, "mel", "proj")!;
    const label = listLabels(app.db, repo.id).find((l) => l.name === "bug")!;
    const res = await fetch(`${base}/mel/proj/issues/1/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ labels: label.id }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const issue = getIssue(app.db, repo.id, 1)!;
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["bug"]);

    const page = await (
      await fetch(`${base}/mel/proj/issues/1`, { headers: { cookie: owner } })
    ).text();
    expect(page).toContain("lc-d73a4a");
    expect(page).toContain(".lc-d73a4a{--label:#d73a4a}");
    expect(page).toContain(">bug</span>");

    // And the list can filter by it.
    const filtered = await (
      await fetch(`${base}/mel/proj/issues?label=bug`)
    ).text();
    expect(filtered).toContain("needs a label");
  });

  test("a stranger cannot apply labels", async () => {
    const res = await fetch(`${base}/mel/proj/issues/1/labels`, {
      method: "POST",
      headers: { cookie: stranger },
      body: form({ labels: "whatever" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303); // a flash explaining the refusal
    const repo = getRepo(app.db, "mel", "proj")!;
    const issue = getIssue(app.db, repo.id, 1)!;
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["bug"]);
  });

  // ---- pull state ----

  test("a pull request closes and reopens from the web", async () => {
    const at = `${base}/mel/proj/pulls/${pullNumber}`;
    await fetch(`${at}/state`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ state: "closed" }),
      redirect: "manual",
    });
    let page = await (await fetch(at)).text();
    expect(page).toContain('data-state="closed"');
    expect(page).toContain("Closed without merging.");
    expect(await (await fetch(`${base}/mel/proj/pulls`)).text()).toContain(
      "No open pull requests",
    );

    await fetch(`${at}/state`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ state: "open" }),
      redirect: "manual",
    });
    page = await (await fetch(at)).text();
    expect(page).toContain('data-state="open"');
    expect(page).toContain("Ready to merge");
  });

  // ---- permission-shaped chrome ----

  test("the Settings tab is shown to admins and to nobody else", async () => {
    const asOwner = await (
      await fetch(`${base}/mel/proj`, { headers: { cookie: owner } })
    ).text();
    expect(asOwner).toContain('href="/mel/proj/settings"');

    for (const cookie of [stranger, ""]) {
      const html = await (
        await fetch(`${base}/mel/proj`, cookie ? { headers: { cookie } } : {})
      ).text();
      expect(html).not.toContain('href="/mel/proj/settings"');
    }
  });

  // ---- raw ----

  test("raw serves bytes as text with nosniff, and conflates not-found", async () => {
    const res = await fetch(`${base}/mel/proj/raw/main/a.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("one\n");

    // A missing file, a hostile ref and a private repo are all the same 404.
    expect((await fetch(`${base}/mel/proj/raw/main/nope.txt`)).status).toBe(
      404,
    );
    expect(
      (await fetch(`${base}/mel/proj/raw/..%2F..%2Fetc/a.txt`)).status,
    ).toBe(404);

    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: stranger },
      body: form({ name: "secret", visibility: "private" }),
      redirect: "manual",
    });
    const hidden = await fetch(`${base}/kim/secret/raw/main/a.txt`);
    const absent = await fetch(`${base}/kim/nothing/raw/main/a.txt`);
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    // Byte-identical once the per-response CSP nonce is normalised: a repo you
    // may not see and one that does not exist give the visitor the same page.
    const scrub = (t: string) => t.replaceAll(/nonce-?="?[\w-]+/g, "nonce");
    expect(scrub(await hidden.text())).toBe(scrub(await absent.text()));
  });

  // ---- ref safety ----

  test("tree and commits refuse a ref that is not a ref", async () => {
    for (const bad of [
      "--upload-pack=touch",
      "..%2F..%2Fetc",
      "main..other",
      "%00main",
    ]) {
      expect((await fetch(`${base}/mel/proj/tree/${bad}`)).status).toBe(404);
    }
    // The commits page falls back to the default branch instead of passing a
    // hostile ?ref= to git.
    const commits = await fetch(`${base}/mel/proj/commits?ref=--output%3Dx`);
    expect(commits.status).toBe(200);
    expect(await commits.text()).toContain("first");

    // A real ref still switches.
    const topic = await fetch(`${base}/mel/proj/commits?ref=topic`);
    expect(await topic.text()).toContain("second");
  });

  // ---- the command palette index ----

  test("the palette index is a data block that cannot close its own script", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "sc-ript", visibility: "public" }),
      redirect: "manual",
    });
    const html = await (
      await fetch(base, { headers: { cookie: owner } })
    ).text();
    const start = html.indexOf(
      '<script type="application/json" id="palette-index">',
    );
    expect(start).toBeGreaterThan(-1);
    const json = html.slice(
      start + '<script type="application/json" id="palette-index">'.length,
      html.indexOf("</script>", start),
    );
    // Every "<" is escaped, so "</script" can never appear inside the block.
    expect(json).not.toContain("<");
    const parsed = JSON.parse(json) as { items: { t: string; h: string }[] };
    expect(parsed.items.some((i) => i.t === "mel/sc-ript")).toBe(true);
    expect(parsed.items.every((i) => i.h.startsWith("/"))).toBe(true);
  });

  // ---- account forms ----

  test("the profile form saves, and rejects a bad email without losing input", async () => {
    const bad = await fetch(`${base}/settings`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ displayName: "Mel Tester", email: "not-an-email" }),
      redirect: "manual",
    });
    expect(bad.status).toBe(422);
    const html = await bad.text();
    expect(html).toContain("Mel Tester"); // the typed value survives
    expect(html).toContain('class="error"');

    const good = await fetch(`${base}/settings`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ displayName: "Mel Tester", email: "mel2@f.dev" }),
      redirect: "manual",
    });
    expect(good.status).toBe(303);
    expect(good.headers.get("set-cookie") ?? "").toContain("forge_flash=");
  });

  test("the password form refuses a wrong current password and a mismatch", async () => {
    const wrong = await fetch(`${base}/settings/password`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({
        current: "not-my-password",
        next: "a-longer-password",
        confirm: "a-longer-password",
      }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(422);

    const mismatch = await fetch(`${base}/settings/password`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({
        current: "web-ui-password",
        next: "a-longer-password",
        confirm: "a-different-one",
      }),
      redirect: "manual",
    });
    expect(mismatch.status).toBe(422);
    // Still the old password, so the rest of this suite keeps working.
    const still = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mel", password: "web-ui-password" }),
    });
    expect(still.status).toBe(201);
  });

  // ---- the confirm page ----

  test("the confirm page only aims at routes it knows are destructive", async () => {
    const ok = await fetch(
      `${base}/-/confirm?to=${encodeURIComponent("/mel/proj/settings/delete")}`,
      { headers: { cookie: owner } },
    );
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('action="/mel/proj/settings/delete"');
    expect(html).toContain("Type mel/proj to continue");
    // The wording comes from the server, never from the link.
    expect(html).not.toContain("Totally safe");

    for (const to of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/mel/proj/issues/new",
      "/api/v1/repos/mel/proj",
    ]) {
      const res = await fetch(
        `${base}/-/confirm?to=${encodeURIComponent(to)}&title=Totally+safe`,
        { headers: { cookie: owner } },
      );
      expect(res.status).toBe(404);
    }
  });

  // ---- repo deletion ----

  test("deleting a repository needs admin and the name typed exactly", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "doomed", visibility: "public" }),
      redirect: "manual",
    });
    const at = `${base}/mel/doomed/settings/delete`;

    // A stranger cannot even find the endpoint.
    expect(
      (
        await fetch(at, {
          method: "POST",
          headers: { cookie: stranger },
          body: form({ confirm: "mel/doomed" }),
          redirect: "manual",
        })
      ).status,
    ).toBe(404);
    expect(getRepo(app.db, "mel", "doomed")).toBeDefined();

    // The owner with the wrong phrase is bounced, and nothing is deleted.
    const wrong = await fetch(at, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ confirm: "doomed" }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(303);
    expect(getRepo(app.db, "mel", "doomed")).toBeDefined();

    const right = await fetch(at, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ confirm: "mel/doomed" }),
      redirect: "manual",
    });
    expect(right.status).toBe(303);
    expect(getRepo(app.db, "mel", "doomed")).toBeUndefined();
  });

  // ---- label editing (the new core + action) ----

  test("a label can be renamed and recolored, but not onto another's name", async () => {
    const repo = getRepo(app.db, "mel", "proj")!;
    await fetch(`${base}/mel/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "chore", color: "0e8a16" }),
      redirect: "manual",
    });
    const chore = listLabels(app.db, repo.id).find((l) => l.name === "chore")!;

    await fetch(`${base}/mel/proj/settings/labels/${chore.id}`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "housekeeping", color: "5319e7" }),
      redirect: "manual",
    });
    const renamed = listLabels(app.db, repo.id).find((l) => l.id === chore.id)!;
    expect(renamed.name).toBe("housekeeping");
    expect(renamed.color).toBe("5319e7");

    // Taking a name another label already holds is refused, not silently lost.
    await fetch(`${base}/mel/proj/settings/labels/${chore.id}`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "bug", color: "5319e7" }),
      redirect: "manual",
    });
    expect(
      listLabels(app.db, repo.id).find((l) => l.id === chore.id)!.name,
    ).toBe("housekeeping");

    // A stranger cannot edit one at all.
    const refused = await fetch(
      `${base}/mel/proj/settings/labels/${chore.id}`,
      {
        method: "POST",
        headers: { cookie: stranger },
        body: form({ name: "theirs", color: "000000" }),
        redirect: "manual",
      },
    );
    expect(refused.status).toBe(404);
    expect(
      listLabels(app.db, repo.id).find((l) => l.id === chore.id)!.name,
    ).toBe("housekeeping");
  });

  // ---- search ----

  test("titles and repository names are searchable", async () => {
    const list = await (
      await fetch(`${base}/mel/proj/issues?q=needs&state=all`)
    ).text();
    expect(list).toContain("needs a label");
    const miss = await (
      await fetch(`${base}/mel/proj/issues?q=nothing-matches-this&state=all`)
    ).text();
    expect(miss).not.toContain("needs a label");
    expect(miss).toContain("No issues match those filters");

    // A LIKE wildcard typed into the box is a literal character, not a glob.
    const wildcard = await (
      await fetch(`${base}/mel/proj/issues?q=%25&state=all`)
    ).text();
    expect(wildcard).not.toContain("needs a label");

    const whole = await (
      await fetch(`${base}/search?q=proj`, { headers: { cookie: owner } })
    ).text();
    // Just the results, not the shell: the palette index legitimately carries
    // every repo the viewer may see, and mel is the site admin here.
    const search = whole.slice(
      whole.indexOf("<main"),
      whole.indexOf("</main>"),
    );
    expect(search).toContain("mel/proj");
    expect(search).not.toContain("kim/secret");
  });

  test("the label colour input submits #rrggbb and is stored as six digits", async () => {
    const repo = getRepo(app.db, "mel", "proj")!;
    await fetch(`${base}/mel/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "tide", color: "#0E8A16" }),
      redirect: "manual",
    });
    const tide = listLabels(app.db, repo.id).find((l) => l.name === "tide");
    expect(tide?.color).toBe("0e8a16");

    // And the page offers a real colour control, so it works with no script.
    const page = await (
      await fetch(`${base}/mel/proj/settings/labels`, {
        headers: { cookie: owner },
      })
    ).text();
    expect(page).toContain('type="color"');
    expect(page).toContain('value="#0e8a16"');
  });

  // ---- markup that a browser will not silently rewrite ----

  /**
   * `<a>` inside `<a>` is not merely invalid: the HTML parser closes the
   * outer anchor and re-parents everything after it as a *sibling*, so a
   * list row visibly falls apart — the author's name and the trailing badge
   * escape the row's padding. This sweeps every list page for it.
   */
  test("no linked list row contains a nested link", async () => {
    const pages = [
      "/",
      "/mel/proj",
      "/mel/proj/issues",
      "/mel/proj/issues?state=all",
      "/mel/proj/pulls?state=all",
      "/mel/proj/commits",
      "/mel",
      "/search?q=a",
    ];
    for (const path of pages) {
      const html = await (
        await fetch(`${base}${path}`, { headers: { cookie: owner } })
      ).text();
      for (const match of html.matchAll(/<a\b[^>]*class="row"[^>]*>/g)) {
        const from = match.index + match[0].length;
        const body = html.slice(from, html.indexOf("</a", from));
        expect({ path, nested: /<a[\s>]/.test(body) }).toEqual({
          path,
          nested: false,
        });
      }
    }
  });

  test("an issue row carries its author inside the meta line", async () => {
    const html = await (
      await fetch(`${base}/mel/proj/issues`, { headers: { cookie: owner } })
    ).text();
    const start = html.indexOf('<span class="row-meta"');
    expect(start).toBeGreaterThan(-1);
    // From the meta to the end of the row it belongs to.
    const meta = html.slice(start, html.indexOf("</a", start));
    expect(meta).toContain("opened");
    expect(meta).toContain('class="avatar"');
    expect(meta).toContain('class="byline-name"');
    expect(meta).toContain("mel");
    // The state is the leading glyph's colour, not a badge repeating the filter.
    expect(html).not.toContain('class="badge" data-state="open"');
  });

  // ---- CSRF ----

  test("every destructive POST refuses a cross-origin submission", async () => {
    const targets = [
      "/mel/proj/issues/1/state",
      "/mel/proj/issues/1/labels",
      `/mel/proj/pulls/${pullNumber}/state`,
      `/mel/proj/pulls/${pullNumber}/merge`,
      "/mel/proj/settings",
      "/mel/proj/settings/labels",
      "/mel/proj/settings/delete",
      "/settings",
      "/settings/password",
      "/settings/tokens",
      "/settings/keys",
      "/logout",
    ];
    for (const path of targets) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { cookie: owner, origin: "https://evil.example" },
        body: form({ state: "closed", confirm: "mel/proj" }),
        redirect: "manual",
      });
      expect([403, 404]).toContain(res.status);
    }
    // Nothing moved.
    expect(getRepo(app.db, "mel", "proj")).toBeDefined();
    const repo = getRepo(app.db, "mel", "proj")!;
    expect(getIssue(app.db, repo.id, 1)!.state).toBe("open");
  });
});
