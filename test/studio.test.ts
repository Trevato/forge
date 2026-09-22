/**
 * The studio: apps as the unit, three verbs, and a switch to dev. The same
 * URLs answer in both modes; the cookie decides which face they show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssue, listIssues } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the studio", () => {
  test("the asks script posts to the form's action attribute: a control named action shadows form.action", async () => {
    const { asksJs } = await import("../src/web/client.ts");
    expect(asksJs).not.toContain("form.action,");
    expect(asksJs).toContain("getAttribute('action')");
    // The select-all box is the script's to reveal and to keep mixed.
    expect(asksJs).toContain("querySelector('.studio-ask-all')");
    expect(asksJs).toContain("all.hidden = boxes.length < 2");
    expect(asksJs).toContain("all.indeterminate = n > 0 && n < boxes.length");
  });

  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;

  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio`, ...extra },
      redirect: "manual",
    });
  const post = (path: string, body: Record<string, string>, extra = "") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: `${cookie}${extra}`, origin: base },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "private",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("home is the studio with the cookie and the repositories without; the switch is a cookie", async () => {
    const plain = await (
      await fetch(`${base}/`, { headers: { cookie } })
    ).text();
    expect(plain).not.toContain("<h1>Studio</h1>");
    const home = await (await get("/")).text();
    expect(home).toContain("Studio");
    expect(home).toContain("notes");
    expect(home).toContain("New app");
    const dev = await (await get("/?mode=dev")).text();
    expect(dev).not.toContain("<h1>Studio</h1>");
    const flipped = await post("/mode", { mode: "dev", back: "/" });
    expect(flipped.status).toBe(303);
    expect(flipped.headers.get("set-cookie")).toContain("forge_mode=dev");
    const asDev = await (
      await get("/", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(asDev).not.toContain("<h1>Studio</h1>");
    const bad = await post("/mode", { mode: "neither", back: "/" });
    expect(bad.headers.get("set-cookie")).toContain("forge_mode=;");
  });

  test("an app's home is the app in the studio, and the code in dev", async () => {
    const studio = await (await get("/alice/notes")).text();
    expect(studio).toContain("Tell the crew");
    expect(studio).toContain("<h2>Crew</h2>");
    expect(studio).toContain(">Studio<");
    expect(studio).not.toContain(">Commits<");
    const dev = await (
      await get("/alice/notes", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).not.toContain("Tell the crew");
    expect(dev).toContain(">Commits<");
  });

  test("telling the crew opens an issue and hands it to a builder", async () => {
    const told = await post("/alice/notes/tell", {
      text: "Make the notes page load in under a second on my phone.\n\nIt takes three seconds now.",
    });
    expect(told.status).toBe(303);
    const issue = listIssues(app.db, repo.id, { kind: "issue", limit: 5 })[0]!;
    expect(issue.title).toBe(
      "Make the notes page load in under a second on my phone.",
    );
    expect(issue.body).toContain("three seconds");
    expect(issue.assigneeName).toBe("scout");
    const again = await (await get("/alice/notes")).text();
    expect(again).toContain("waiting");
    expect(again).toContain(">scout<");
    const empty = await post("/alice/notes/tell", { text: "   " });
    expect(empty.status).toBe(303);
  });

  test("ship lands a change; say tells the crew", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Faster",
      body: "Closes #1",
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const said = await post(`/alice/notes/pulls/${pull.number}/say`, {
      text: "Keep the images lazy too.",
    });
    expect(said.status).toBe(303);
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed in 1s" });
    // A bare POST — a button with no fields, or a client that sent no body
    // at all — ships too: an empty form is not a bad request.
    const shipped = await fetch(
      `${base}/alice/notes/pulls/${pull.number}/ship`,
      {
        method: "POST",
        headers: { cookie: `${cookie}; forge_mode=studio`, origin: base },
        redirect: "manual",
      },
    );
    expect(shipped.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(getIssue(app.db, repo.id, 1)?.state).toBe("closed");
    const page = await (await get("/alice/notes")).text();
    expect(page).toContain("shipped");
    // What was told and then shipped is not still "waiting" in Now.
    expect(page).not.toContain(">waiting<");
    expect(getUserByName(app.db, "scout")).toBeDefined();
  });

  test("several asks, one decision: a box per ask, one bar, one post; in place when asked for JSON", async () => {
    const scout = getUserByName(app.db, "scout")!;
    // The crew proposes: a pull by scout on its own branch.
    const ask = async (name: string): Promise<Pull> => {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `ask/${name}`,
        base: "main",
        message: `Ask ${name}`,
        files: [{ path: `${name}.md`, content: `${name}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, scout, repo, {
        title: `Ask ${name}`,
        body: "",
        baseBranch: "main",
        headBranch: `ask/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };
    const check = (pull: Pull, state: "ok" | "failed") => {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: pull.headOid,
        reason: "pull",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state, summary: `check ${state}` });
    };
    const a = await ask("a");
    const b = await ask("b");
    const c = await ask("c");
    const d = await ask("d");
    check(a, "ok");
    check(b, "ok");
    check(d, "ok");
    // c: red, and the crew tried its limit since anyone spoke — it stopped.
    check(c, "failed");
    await Bun.sleep(5);
    // Each try is over: a run still queued or running would make c the
    // crew's, not a question for a person.
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: c.id,
        reason: "check_failed",
        actorId: scout.id,
      });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "failed", summary: "still red" });
    }

    // (a) One box per ask, one form around them, the bar's actions, and a
    // row's own form outside the panel's — never a form in a form.
    const page = await (await get("/alice/notes")).text();
    expect(page.match(/class="studio-ask-pick"/g)?.length).toBe(4);
    expect(page).toContain(`value="look:${a.id}"`);
    expect(page).toContain(`value="stopped:${c.id}"`);
    expect(page).toContain('action="/studio/asks"');
    expect(page).toMatch(/name="action"\s+value="ship"/);
    expect(page).toMatch(/name="action"\s+value="close"/);
    expect(page).toContain(`form="ask-look:${a.id}"`);
    expect(page).toContain(`id="ask-look:${a.id}"`);
    expect(page).toContain(`id="ask-stopped:${c.id}"`);
    const panel = page.slice(page.indexOf('action="/studio/asks"'));
    expect(panel.slice(0, panel.indexOf("</form>"))).not.toContain("<form");
    // One select-all over the column, in the head before any row: labelled,
    // nameless (it never posts), hidden until the script reveals it.
    const selectAll =
      /<input\s+class="studio-ask-pick studio-ask-all"\s+type="checkbox"\s+aria-label="Select all asks"\s+hidden\s*\/>/g;
    expect(page.match(selectAll)?.length).toBe(1);
    expect(page.indexOf('class="studio-ask-pick studio-ask-all"')).toBeLessThan(
      page.indexOf('class="studio-ask-pick"'),
    );

    // (b) One decision for two; the third does not take it and is skipped.
    const bulk = (body: [string, string][], accept?: string) =>
      fetch(`${base}/studio/asks`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=studio`,
          origin: base,
          ...(accept === undefined ? {} : { accept }),
        },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    const shipped = await bulk([
      ["ask", `look:${a.id}`],
      ["ask", `look:${b.id}`],
      ["ask", `stopped:${c.id}`],
      ["action", "ship"],
      ["back", "/alice/notes"],
    ]);
    expect(shipped.status).toBe(303);
    expect(shipped.headers.get("location")).toBe("/alice/notes");
    expect(
      decodeURIComponent(shipped.headers.get("set-cookie") ?? ""),
    ).toContain("Shipped 2 · skipped 1");
    expect(getPull(app.db, repo.id, a.number)?.mergedAt).not.toBeNull();
    expect(getPull(app.db, repo.id, b.number)?.mergedAt).not.toBeNull();
    expect(getPull(app.db, repo.id, c.number)?.state).toBe("open");

    // (c) Asked for JSON, the route says what was done and what was skipped
    // — an ask already decided is skipped, not guessed at.
    const closed = await bulk(
      [
        ["ask", `stopped:${c.id}`],
        ["ask", `look:${a.id}`],
        ["action", "close"],
      ],
      "application/json",
    );
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({
      ok: true,
      flash: "Closed 1 · skipped 1",
      done: [`stopped:${c.id}`],
      skipped: [`look:${a.id}`],
      failed: [],
    });
    expect(getPull(app.db, repo.id, c.number)?.state).toBe("closed");
    const nothing = await bulk(
      [
        ["ask", "look:nothing"],
        ["action", "close"],
      ],
      "application/json",
    );
    expect(nothing.status).toBe(422);
    expect(await nothing.json()).toEqual({
      ok: false,
      error: "Closed 0 · skipped 1",
      done: [],
      skipped: ["look:nothing"],
      failed: [],
    });

    // One ask left: its own box is the whole choice — no select-all.
    const one = await (await get("/alice/notes")).text();
    expect(one.match(/class="studio-ask-pick"/g)?.length).toBe(1);
    expect(one).not.toContain('class="studio-ask-pick studio-ask-all"');

    // (d) A row's own button answers the same two ways: JSON when asked,
    // the redirect and flash otherwise.
    const ship = (accept?: string) =>
      fetch(`${base}/alice/notes/pulls/${d.number}/ship`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=studio`,
          origin: base,
          ...(accept === undefined ? {} : { accept }),
        },
        redirect: "manual",
      });
    const inPlace = await ship("application/json");
    expect(inPlace.status).toBe(200);
    expect(await inPlace.json()).toEqual({
      ok: true,
      flash: 'Shipped "Ask d". Production is redeploying.',
    });
    expect(getPull(app.db, repo.id, d.number)?.mergedAt).not.toBeNull();
    const refused = await ship("application/json");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ ok: false });
    const plain = await ship();
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/alice/notes");
    // Nothing asks any more: no box, no panel.
    const after = await (await get("/alice/notes")).text();
    expect(after).not.toContain('class="studio-ask-pick"');
    expect(after).not.toContain('class="studio-ask-pick studio-ask-all"');
    expect(after).not.toContain('action="/studio/asks"');
  });
});
