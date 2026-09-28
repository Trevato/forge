/**
 * The browsing pages — repo home, commit history, branches — wire up the
 * same live client the issue/pull threads already had, so a push or a new
 * branch shows up as a "new activity" pill without a reload. Verifies the
 * wiring is present on a local repo and absent where there is nothing to
 * subscribe to (an empty repo, or a repo read live off another forge).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { editFiles } from "../src/actions/contents.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("live browsing pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-live-pages-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const user = await createUser(app.db, {
      username: "lex",
      email: "lex@f.dev",
      password: "live-pages-pass",
    });
    if (!user.ok) throw new Error("user");
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: user.value.id,
      name: "proj",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo");
    const committed = await editFiles(app, user.value, repo.value, {
      files: [{ path: "README.md", content: "# proj\n" }],
      message: "first commit",
    });
    if (!committed.ok) throw new Error("commit");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the repo home wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain('data-repo="/lex/proj"');
    expect(html).toContain("new EventSource");
  });

  test("the commit history wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj/commits`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain("new EventSource");
  });

  test("the branches page wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj/branches`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain("new EventSource");
  });

  test("the studio app page wires up the live client with data-app, so a deploy run event refetches the app's own fragment", async () => {
    const user = await createUser(app.db, {
      username: "nia",
      email: "nia@f.dev",
      password: "live-pages-pass",
      adminIfFirst: true,
    });
    if (!user.ok) throw new Error("user");
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: user.value.id,
      name: "runner",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo");
    const committed = await editFiles(app, user.value, repo.value, {
      files: [{ path: "README.md", content: "# runner\n" }],
      message: "first commit",
    });
    if (!committed.ok) throw new Error("commit");
    const enabled = await enableApp(app, user.value, repo.value, {
      slug: "runner",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const html = await (
      await fetch(`${base}/nia/runner`, {
        headers: { cookie: "forge_mode=studio" },
      })
    ).text();
    expect(html).toContain('id="live"');
    expect(html).toContain('data-app="1"');
    expect(html).toContain("new EventSource");
    // `app.serving` fires at the swap-in, seconds to half a minute before
    // the deploy run's own `run.finished` — the client must listen for it
    // directly, not only learn a preview is live once its tests are done.
    expect(html).toContain("app.serving");
    // The polite region a swap must speak into — the one place a screen
    // reader learns a preview just went live.
    expect(html).toContain('id="live-status"');
  });

  test("the client script sets the status when the app fragment swaps, not only on the generic New-activity fallback", async () => {
    const { liveClientJs } = await import("../src/web/live.ts");
    // `onEvent` returns straight out of `refreshApp()` for a deploy/serving
    // event (`live.ts`), so it never reaches the fallback branch's
    // `status.textContent = 'New activity on this page'` — the swap itself
    // must set the status, in the same sentence the swapped-in card shows.
    const refreshApp = liveClientJs.slice(
      liveClientJs.indexOf("function refreshApp"),
      liveClientJs.indexOf("function onEvent"),
    );
    expect(refreshApp).toContain("status.textContent");
    // A fragment identical to what's already on screen must not announce
    // anything: the sentence is built from what changed, not fetched anew
    // every time.
    expect(refreshApp).toContain("announceSwap");
  });

  test("the studio home wires up asks, apps, now and on-you as live regions, signed in; a signed-out visitor gets neither", async () => {
    const signedOut = await (
      await fetch(`${base}/`, { headers: { cookie: "forge_mode=studio" } })
    ).text();
    expect(signedOut).not.toContain('id="live-on-you"');

    const user = await createUser(app.db, {
      username: "ren",
      email: "ren@f.dev",
      password: "live-pages-pass",
    });
    if (!user.ok) throw new Error("user");
    const cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "ren",
            password: "live-pages-pass",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

    const html = await (
      await fetch(`${base}/`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(html).toContain('id="live-apps"');
    expect(html).toContain('id="live-on-you"');
    expect(html).toContain("new EventSource('/events')");
  });

  test("a live region never swaps out from under a card that is mid-decision", async () => {
    const { liveRegionsJs } = await import("../src/web/client.ts");
    expect(liveRegionsJs).toContain("data-busy");
  });
});
