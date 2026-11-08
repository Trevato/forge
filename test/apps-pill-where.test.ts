/**
 * What the forge pill says (#2178): the app, the environment and, for a
 * preview, the pull and its title as escaped data attributes; the title
 * withheld from a viewer who may not read the pull; the panel closing on a
 * pointerdown outside it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { pillWhere, type AppTarget } from "../src/apps/proxy.ts";
import { toolbarJs, toolbarTag, withToolbar } from "../src/apps/toolbar.ts";
import type { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the pill's data", () => {
  let dataDir: string;
  let app: App;
  let runtime: AppsRuntime;
  let aliceId: string;
  const targets: Record<string, AppTarget> = {};
  const pulls: Record<string, number> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pill-where-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    runtime = { app } as unknown as AppsRuntime;
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    aliceId = a.value.id;
    for (const [name, visibility] of [
      ["open", "public"],
      ["closed", "private"],
      ["leaky", "private"],
    ] as const) {
      const made = await newApp(app, a.value, { name, description: "x", visibility });
      if (!made.ok) throw new Error(String(made.error));
      // The app's access is its own: this one is open on a private repo.
      if (name === "leaky")
        app.db.run("UPDATE app SET access='public' WHERE repo_id=?1", [made.value.repo.id]);
      const record = getAppByRepo(app.db, made.value.repo.id)!;
      targets[name] = { app: record, env: "production" } as AppTarget;
      const pull = createIssue(app.db, {
        repoId: made.value.repo.id,
        authorId: a.value.id,
        title: `<img src=x onerror=alert(1)> "q" & ${name}`,
        kind: "pull",
      });
      if (!pull.ok) throw new Error(pull.error);
      pulls[name] = pull.value.number;
    }
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const preview = (name: string): AppTarget =>
    ({ ...targets[name]!, env: `pull-${pulls[name]}` }) as AppTarget;

  test("production names the app and the environment, no pull", () => {
    expect(pillWhere(runtime, targets.open!, undefined)).toEqual({
      app: targets.open!.app.slug,
      repo: "alice/open",
      env: "production",
    });
  });

  test("a preview carries the pull number and, on a public repo, its title", () => {
    const where = pillWhere(runtime, preview("open"), undefined);
    expect(where.pull).toBe(pulls.open!);
    expect(where.env).toBe(`pull-${pulls.open}`);
    expect(where.title).toContain("onerror");
  });

  test("the title is withheld from a viewer who may not read the pull", () => {
    const anon = pillWhere(runtime, preview("closed"), undefined);
    expect(anon.pull).toBe(pulls.closed!);
    expect(anon.title).toBeUndefined();
    const owner = pillWhere(runtime, preview("closed"), { id: aliceId } as never);
    expect(owner.title).toContain("closed");
  });

  test("a public app on a private repo names the repo only to a reader", async () => {
    expect(targets.leaky!.app.access).toBe("public");
    expect(pillWhere(runtime, targets.leaky!, undefined).repo).toBeUndefined();
    expect(pillWhere(runtime, preview("leaky"), undefined).title).toBeUndefined();
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    const stranger = pillWhere(runtime, targets.leaky!, { id: bob.value.id } as never);
    expect(stranger.repo).toBeUndefined();
    const owner = pillWhere(runtime, targets.leaky!, { id: aliceId } as never);
    expect(owner.repo).toBe("alice/leaky");
  });

  test("a title with markup is escaped inside the attribute", () => {
    const tag = toolbarTag("http://f.test", {
      app: "a",
      env: "pull-3",
      pull: 3,
      title: `<img src=x onerror=alert(1)> "q" & 'z'`,
    });
    expect(tag).not.toContain("<img");
    expect(tag).toContain(
      `data-title="&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;z&#39;"`,
    );
    expect(tag.match(/<script/g)?.length).toBe(1);
    const page = new TextDecoder().decode(
      withToolbar(new TextEncoder().encode("<body></body>"), "http://f.test", {
        app: "a",
        env: "production",
      }),
    );
    expect(page).toContain(`data-app="a" data-env="production"`);
  });
});

describe("the pill's script", () => {
  test("registers the outside-pointerdown close beside Escape and the tap", () => {
    expect(toolbarJs).toContain('addEventListener("pointerdown"');
    expect(toolbarJs).toContain('"Escape"');
    expect(toolbarJs).toContain('pill.addEventListener("click"');
  });

  test("the aria-label follows the environment, from the same data attributes", () => {
    function label(data: Record<string, string>): string {
      let name = "";
      const pill = { type: "", textContent: "", style: {}, setAttribute: (k: string, v: string) => { if (k === "aria-label") name = v; }, addEventListener() {} };
      const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, set hidden(_v: boolean) {} });
      let buttons = 0;
      const doc = {
        currentScript: { src: "https://forge.test/assets/x.js", dataset: data },
        // The first button is the pill; the panel's close button is another.
        createElement: (t: string) => (t === "button" && buttons++ === 0 ? pill : { ...el(), attachShadow: () => ({ appendChild() {} }) }),
        addEventListener() {},
        body: { appendChild() {} },
      };
      new Function("window", "document", "URL", toolbarJs)({}, doc, URL);
      return name;
    }
    expect(label({ app: "notes", env: "production" })).toBe("notes, production");
    expect(label({ app: "notes", env: "preview", pull: "7" })).toBe("notes, preview of pull #7");
    expect(label({})).toBe("Forge");
  });

  test("puts text in with textContent and checks the home href against the forge origin", () => {
    expect(toolbarJs).toContain("textContent = text");
    expect(toolbarJs).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(toolbarJs).toContain("target.origin === fo");
  });
});
