/**
 * A preview of the forge looked at as its owner (#8812): `app.looksAsOwner`
 * names pages whose phone and desktop are taken signed in as an admin even
 * of a public app, while every other page is still taken as nobody; a
 * preview of the forge seeds a preview-only admin and a small world, and
 * hears the parent's signed admin as that admin — production refuses both.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { previewEnv } from "../src/apps/data.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { readGrant } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp, type App } from "../src/app.ts";
import { listPins } from "../src/boards/pins.ts";
import { listBets } from "../src/core/bets.ts";
import { pickSubscription } from "../src/core/subscriptions.ts";
import { looksForEnv } from "../src/core/looks.ts";
import { listPulls } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { readPipes } from "../src/flow/pipes.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import type { Capture, LookInput } from "../src/looks/capture.ts";
import { startLooks, type LooksHandle } from "../src/looks/service.ts";
import { previewIdentityKey } from "../src/spawn/preview-owner.ts";
import {
  PREVIEW_ADMIN,
  PREVIEW_PULL,
  PREVIEW_PULL_PAGE,
  PREVIEW_REPO,
  PREVIEW_REPO_HOME,
  PREVIEW_WAVE,
  PREVIEW_WAVE_HEADLINE,
  seedPreview,
} from "../src/spawn/preview-seed.ts";
import { PREVIEW_CONFIG_FILES } from "../src/spawn/preview-config.ts";
import { ownerLooksFor, PREVIEW_FORKS, PREVIEW_ITERATIONS_PAGE } from "../src/spawn/preview-looks.ts";
import { iterationsOf } from "../src/core/iterations.ts";
import { localSource } from "../src/view/local.ts";
import { isFormConfig, parseConfig } from "../src/web/render/config-format.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("app.looksAsOwner in forge.json", () => {
  const manifest = (app: Record<string, unknown>) =>
    parseManifest(JSON.stringify({ app: { run: "bun x", ...app } }), undefined);

  test("names pages of app.looks; absent is none", () => {
    const named = manifest({ looks: ["/", "/flow"], looksAsOwner: ["/flow"] });
    expect(named.ok && named.value.looksAsOwner).toEqual(["/flow"]);
    const absent = manifest({ looks: ["/"] });
    expect(absent.ok && absent.value.looksAsOwner).toEqual([]);
  });

  test("a page app.looks does not name, or a path that is not one, is refused", () => {
    const stray = manifest({ looks: ["/"], looksAsOwner: ["/flow"] });
    expect(!stray.ok && stray.error.kind === "invalid" && stray.error.message).toContain(
      "app.looksAsOwner names /flow",
    );
    for (const bad of ["flow", "//evil.example", "/a/../b", 7])
      expect(manifest({ looks: ["/"], looksAsOwner: [bad] }).ok).toBe(false);
  });

  test("the forge's own looks take its admin pages as the owner", () => {
    const own = parseManifest(readFileSync(join(import.meta.dir, "..", "forge.json"), "utf8"), undefined);
    expect(own.ok && own.value.looksAsOwner).toEqual(expect.arrayContaining(["/resilience", "/system"]));
  });
});

describe("the preview seed", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-preview-seed-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("production, or no word from the platform, refuses it and makes no one", async () => {
    for (const env of [{ FORGE_APP_ENV: "production" }, {}, { FORGE_APP_ENV: "previewish" }]) {
      const refused = await seedPreview(app, env);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error).toBe("not_preview");
    }
    expect(getUserByName(app.db, PREVIEW_ADMIN)).toBeUndefined();
    expect(previewIdentityKey({ FORGE_APP_ENV: "production", FORGE_APP_IDENTITY_KEY: "k" })).toBeUndefined();
    expect(previewIdentityKey({ FORGE_APP_IDENTITY_KEY: "k" })).toBeUndefined();
    expect(previewIdentityKey({ FORGE_APP_ENV: "preview", FORGE_APP_IDENTITY_KEY: "k" })).toBe("k");
  });

  test("a preview seeds an admin with no password, a repository with issues and a pull, a flow week and pins — once", async () => {
    const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
    expect(seeded).toEqual(ok({ seeded: true }));
    const admin = getUserByName(app.db, PREVIEW_ADMIN)!;
    expect(admin.isAdmin).toBe(true);
    const hash = app.db
      .query<{ password_hash: string }, [string]>("SELECT password_hash FROM user WHERE id = ?1")
      .get(admin.id);
    expect(hash?.password_hash).toBe("");
    expect(app.db.query("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    expect(repo).toBeDefined();
    const issues = app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue'")
      .get(repo.id);
    expect(issues?.n).toBe(11);
    expect(listPulls(app.db, repo.id).length).toBe(1);
    expect(listRuns(app.db, repo.id, { kind: "agent" }).every((r) => r.state === "ok")).toBe(true);
    const pipes = readPipes(app.db, admin.id);
    expect(pipes.usd).toBeGreaterThan(0);
    expect(pipes.valves.find((v) => v.slug === `${PREVIEW_ADMIN}/${PREVIEW_REPO}`)?.level).toBe(60);
    expect(listPins(app.db, admin.id).length).toBe(2);
    const bets = listBets(app.db, repo.id).map((b) => [b.name, b.state, b.appetite]);
    expect(bets).toEqual([
      ["Show the week", "backed", 20],
      ["Price the list", "proposed", 20],
    ]);

    // The sample account that prices the week has no grant, so no run or
    // conversation in a preview can be handed its inert token: the admin
    // falls through to the platform's own credential.
    expect(app.db.query("SELECT COUNT(*) AS n FROM subscription WHERE name = 'preview sample'").get()).toEqual({ n: 1 });
    const picked = pickSubscription(app.db, app.config.dataDir, { repoId: repo.id, ownerId: admin.id, agentId: "" }, new Date());
    expect(picked.kind).toBe("env");

    expect(await seedPreview(app, { FORGE_APP_ENV: "preview" })).toEqual(ok({ seeded: false }));
    expect(listPins(app.db, admin.id).length).toBe(2);
  }, 30_000);

  test("the sample holds a YAML and a TOML file that open as a form; a sample seeded before them gets them once", async () => {
    const admin = getUserByName(app.db, PREVIEW_ADMIN)!;
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    const fileAt = async (path: string): Promise<string | undefined> => {
      const blob = await localSource(app, repo, undefined).blob(repo.defaultBranch, path);
      return blob.ok && blob.value.kind === "text" ? new TextDecoder().decode(blob.value.body) : undefined;
    };
    for (const { path, content } of PREVIEW_CONFIG_FILES) {
      expect(isFormConfig(path)).toBe(true);
      expect(parseConfig(path, content).ok).toBe(true);
      expect(await fileAt(path)).toBe(content);
    }
    // An older preview: seeded, without the files or the note that it has them.
    const gone = await commitToBranch(app, admin, repo, {
      message: "as before #7337",
      files: PREVIEW_CONFIG_FILES.map(({ path }) => ({ path, content: null })),
    });
    expect(gone.ok).toBe(true);
    app.db.query("DELETE FROM user_setting WHERE user_id = ?1 AND key = 'preview_config_seeded'").run(admin.id);
    expect(await seedPreview(app, { FORGE_APP_ENV: "preview" })).toEqual(ok({ seeded: false }));
    for (const { path, content } of PREVIEW_CONFIG_FILES) expect(await fileAt(path)).toBe(content);
    // And only once: removed again, a later boot leaves them removed.
    await commitToBranch(app, admin, repo, { files: PREVIEW_CONFIG_FILES.map(({ path }) => ({ path, content: null })) });
    expect(await seedPreview(app, { FORGE_APP_ENV: "preview" })).toEqual(ok({ seeded: false }));
    expect(await fileAt("service.yml")).toBeUndefined();
  }, 30_000);
});

describe("a preview hears its parent's admin as the preview admin", () => {
  const KEY = "the-parents-identity-key";
  const dirs: string[] = [];
  const apps: App[] = [];
  const servers: Servers[] = [];

  async function forge(previewIdentityKey?: string): Promise<Servers> {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-preview-owner-"));
    dirs.push(dataDir);
    const app = createApp({ dataDir, port: 0, ...(previewIdentityKey === undefined ? {} : { previewIdentityKey }) });
    apps.push(app);
    const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
    if (!seeded.ok) throw new Error(seeded.error);
    const s = await serve(app);
    servers.push(s);
    return s;
  }
  const identity = (role: string, key = KEY, expires = Date.now() + 60_000) => {
    const said = `u1|trevato|${role}|${expires}`;
    return {
      "x-forge-identity": said,
      "x-forge-signature": createHmac("sha256", key).update(said).digest("base64url"),
    };
  };
  const flow = (s: Servers, headers: Record<string, string>) =>
    fetch(`${s.url}/flow`, { headers, redirect: "manual" });

  afterAll(async () => {
    for (const s of servers) s.stop();
    for (const a of apps) a.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("a signed admin is the preview admin; a reader, a forged or a stale signature is nobody", async () => {
    const preview = await forge(KEY);
    const signedIn = await flow(preview, identity("admin"));
    expect(signedIn.status).toBe(200);
    const page = await signedIn.text();
    expect(page).toContain("<h1>Flow</h1>");
    expect(page).toContain(`${PREVIEW_ADMIN}/${PREVIEW_REPO}`);
    // No session is made for it: nothing to show, nothing to log.
    expect(signedIn.headers.get("set-cookie") ?? "").not.toContain("forge_session");
    for (const headers of [
      identity("user"),
      identity("admin", "not-the-key"),
      identity("admin", KEY, Date.now() - 1),
      {},
    ])
      expect((await flow(preview, headers)).status).not.toBe(200);
  }, 30_000);

  test("Next up has a cut line inside the list and /bets a backed bet and a proposed one", async () => {
    const preview = servers[0]!;
    const base = `${preview.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}`;
    const next = await (await fetch(`${base}/next`, { headers: identity("admin") })).text();
    expect(next).toContain('role="separator"');
    expect(next).toContain("below this line reads as next week");
    expect(next).not.toContain("too little history");
    const bets = await (await fetch(`${base}/bets`, { headers: identity("admin") })).text();
    expect(bets).toContain("Show the week");
    expect(bets).toContain("Price the list");
    expect(bets).toContain("20%");
  });

  test("a mutation it rides is held to the same-origin rule", async () => {
    const preview = servers[0]!;
    const turned = await fetch(`${preview.url}/flow/valve`, {
      method: "POST",
      headers: { ...identity("admin"), origin: "https://elsewhere.example" },
      body: new URLSearchParams({ repo: `${PREVIEW_ADMIN}/${PREVIEW_REPO}`, level: "10" }),
      redirect: "manual",
    });
    expect(turned.status).toBe(403);
  });

  test("/resilience and /system answer the preview admin, with no store said in one line and no credential in the page", async () => {
    const preview = servers[0]!;
    const headers = identity("admin");
    for (const path of ["/resilience", "/system"]) {
      const res = await fetch(`${preview.url}${path}`, { headers, redirect: "manual" });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie") ?? "").not.toContain("forge_session");
      const page = await res.text();
      for (const secret of [KEY, headers["x-forge-signature"], headers["x-forge-identity"]])
        expect(page).not.toContain(secret);
      const sessions = apps[0]!.db.query<{ id: string }, []>("SELECT id FROM session").all();
      for (const { id } of sessions) expect(page).not.toContain(id);
      if (path === "/resilience") {
        expect(page).toContain("Backups are off here: this forge was given no bucket to keep snapshots in.");
        expect(page).not.toMatch(/\bat .+\.ts:\d+/);
      }
    }
  }, 30_000);

  test("production, never handed the key, hears nobody", async () => {
    const production = await forge(undefined);
    expect((await flow(production, identity("admin"))).status).not.toBe(200);
  }, 30_000);
});

describe("the forge's own owner looks, over the preview seed", () => {
  // Each page forge.json takes as the owner, and what shows it is not blank (#8865).
  const repoHome = PREVIEW_REPO_HOME;
  const pullPage = PREVIEW_PULL_PAGE;
  const KEY = "the-parents-identity-key";
  let dataDir: string;
  let app: App;
  let s: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-owner-looks-"));
    app = createApp({ dataDir, port: 0, previewIdentityKey: KEY });
    const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
    if (!seeded.ok) throw new Error(seeded.error);
    s = await serve(app);
  }, 30_000);
  afterAll(async () => {
    s.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const asOwner = async (path: string) => {
    const said = `u1|trevato|admin|${String(Date.now() + 60_000)}`;
    const res = await fetch(`${s.url}${path}`, {
      headers: { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    return res.text();
  };

  test("forge.json takes the seed's other pages as the owner, and the seed's pull is the one the named list pictures", () => {
    const manifest = parseManifest(readFileSync(join(import.meta.dir, "..", "forge.json"), "utf8"), undefined);
    if (!manifest.ok) throw new Error(JSON.stringify(manifest.error));
    for (const page of ["next", "bets", "waves", "milestones"].map((p) => `${repoHome}/${p}`)) {
      expect(manifest.value.looks).toContain(page);
      expect(manifest.value.looksAsOwner).toContain(page);
    }
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    expect(listPulls(app.db, repo.id).map((p) => p.number)).toEqual([PREVIEW_PULL]);
  });

  test("home holds the pins, and the fragment it fills them from draws them", async () => {
    expect(await asOwner("/")).toContain('data-refresh="/live/home/panels"');
    const pins = await asOwner("/live/home/panels");
    expect(pins).toContain('aria-label="Pinned panels"');
    expect(pins).toContain("Runs by kind");
  });

  test("/flow draws a pipe", async () => {
    expect(await asOwner("/flow")).toContain('class="pipe ');
  });

  test("the repository's home carries the head's title", async () => {
    const page = await asOwner(repoHome);
    expect(page).toContain('<h1 class="repo-title">');
    expect(page).toContain(`href="${repoHome}">${PREVIEW_REPO}`);
  });

  test("/waves holds the wave and /milestones a milestone that is two of three done", async () => {
    const waves = await asOwner(`${repoHome}/waves`);
    expect(waves).toContain(PREVIEW_WAVE);
    expect(waves).toContain(PREVIEW_WAVE_HEADLINE);
    expect(waves).toContain("1 pull");
    const milestones = await asOwner(`${repoHome}/milestones`);
    expect(milestones).toContain("The home page says hello");
    expect(milestones).toContain("2 of 3 done");
  });

  test("the pull's page carries the Ship decision", async () => {
    const page = await asOwner(pullPage);
    const decide = page.indexOf('id="decide"');
    expect(decide).toBeGreaterThan(-1);
    expect(page.slice(decide, decide + 2000)).toMatch(/data-variant="primary"[^>]*>\s*Ship\s*</);
  });
});

describe("looks of a public app", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let looks: LooksHandle;
  let alice: User;
  const calls: LookInput[] = [];
  const fake: Capture = async (input) => {
    calls.push(input);
    writeFileSync(input.out, PNG);
    return ok({ entries: {} });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-looks-owner-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    looks = startLooks(app, { localUrl: servers.url, capture: fake });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
  }, 30_000);

  afterAll(async () => {
    await looks.stop();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a page listed as owner carries the admin grant; one not listed is still taken as nobody", async () => {
    const made = await newApp(app, alice, { name: "plaza", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const { repo, app: record } = made.value;
    expect(record.access).toBe("public");
    const branch = await commitToBranch(app, alice, repo, {
      branch: "pages",
      base: repo.defaultBranch,
      message: "Picture /flow as the owner",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            app: {
              run: "bun run src/server.ts",
              health: "/healthz",
              looks: ["/", "/flow"],
              looksAsOwner: ["/flow"],
            },
          }),
        },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Pages",
      baseBranch: repo.defaultBranch,
      headBranch: "pages",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = previewEnv(opened.value.number);
    const commit = branch.value.commitOid;
    const deadline = Date.now() + 90_000;
    const light = () =>
      looksForEnv(app.db, record.id, env).filter((l) => l.commitOid === commit && l.theme === "light");
    while (light().length < 6 && Date.now() < deadline) await Bun.sleep(100);
    if (light().length < 6) throw new Error(`never came: still waiting while light().length < 6`);
    await looks.idle();
    const rows = light();
    const taken = (page: string, kind: string) =>
      rows.find((l) => l.page === page && l.kind === kind)?.takenAs;
    expect(taken("/flow", "phone")).toBe("owner");
    expect(taken("/flow", "desktop")).toBe("owner");
    expect(taken("/flow", "thumb")).toBe("nobody");
    expect(taken("/", "phone")).toBe("nobody");
    expect(taken("/", "desktop")).toBe("nobody");

    const grantOf = (page: string, width: number) => {
      const call = calls.find(
        (c) =>
          c.url.includes(`plaza--${opened.value.number}.`) &&
          new URL(c.url).searchParams.get("to") === page &&
          c.width === width &&
          c.dark !== true &&
          !c.out.includes("thumb"),
      )!;
      return readGrant(dataDir, new URL(call.url).searchParams.get("t") ?? "", { app: record, env });
    };
    expect(grantOf("/flow", 390)?.who).toEqual({ id: alice.id, name: "alice", role: "admin" });
    expect(grantOf("/flow", 1280)?.who).toEqual({ id: alice.id, name: "alice", role: "admin" });
    expect(grantOf("/", 390)?.who).toBeUndefined();
    expect(grantOf("/", 1280)?.who).toBeUndefined();
  }, 120_000);

  test("a preview of the forge's own repository takes home, /flow, the repository's head and the pull as the owner at desk and phone, whatever forge.json lists", async () => {
    const made = await newApp(app, alice, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const { repo, app: record } = made.value;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "pages",
      base: repo.defaultBranch,
      message: "List only home",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({ app: { run: "bun run src/server.ts", health: "/healthz", looks: ["/"] } }),
        },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, { title: "Pages", baseBranch: repo.defaultBranch, headBranch: "pages" });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = previewEnv(opened.value.number);
    const commit = branch.value.commitOid;
    const pages = ["/", "/flow", PREVIEW_REPO_HOME, PREVIEW_PULL_PAGE, PREVIEW_ITERATIONS_PAGE];
    const deadline = Date.now() + 90_000;
    const light = () =>
      looksForEnv(app.db, record.id, env).filter((l) => l.commitOid === commit && l.theme === "light");
    while (light().length < pages.length * 3 && Date.now() < deadline) await Bun.sleep(100);
    if (light().length < pages.length * 3) throw new Error(`never came: still waiting while light().length < pages.length * 3`);
    await looks.idle();
    const rows = light();
    for (const page of pages) {
      for (const [kind, width] of [["desktop", 1280], ["phone", 390]] as const) {
        expect({ page, kind, takenAs: rows.find((l) => l.page === page && l.kind === kind)?.takenAs }).toEqual({
          page,
          kind,
          takenAs: "owner",
        });
        const call = calls.find(
          (c) =>
            c.url.includes(`forge--${opened.value.number}.`) &&
            new URL(c.url).searchParams.get("to") === page &&
            c.width === width &&
            c.dark !== true &&
            !c.out.includes("thumb"),
        );
        expect(call).toBeDefined();
        const grant = readGrant(dataDir, new URL(call!.url).searchParams.get("t") ?? "", { app: record, env });
        expect(grant?.who).toEqual({ id: alice.id, name: "alice", role: "admin" });
      }
      // The thumb is what a stranger sees, still.
      expect(rows.find((l) => l.page === page && l.kind === "thumb")?.takenAs).toBe("nobody");
    }
  }, 120_000);

  test("production of the forge, and a preview of any other repository, add none", () => {
    const forge = { ownerName: "alice", name: "forge" };
    expect(ownerLooksFor("alice/forge", forge, "production")).toEqual([]);
    expect(ownerLooksFor("alice/forge", { ownerName: "alice", name: "plaza" }, previewEnv(1))).toEqual([]);
    expect(ownerLooksFor(undefined, forge, previewEnv(1))).toEqual([]);
    expect(ownerLooksFor("alice/forge", forge, previewEnv(1)).length).toBeGreaterThan(0);
  });
});

describe("the Iterations page of the seeded fork family (#9182)", () => {
  test("the owner's looks include it at desk and phone", () => {
    const forge = { ownerName: "alice", name: "forge" };
    const looks = ownerLooksFor("alice/forge", forge, previewEnv(1)).filter((l) => l.page === PREVIEW_ITERATIONS_PAGE);
    expect(PREVIEW_ITERATIONS_PAGE).toBe("/preview-admin/sample/iterations");
    expect(looks.map((l) => l.kind).sort()).toEqual(["desktop", "phone"]);
  });

  test("the seeded repository has the forks the page draws, each with a build of its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-iterations-seed-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
      if (!seeded.ok) throw new Error(seeded.error);
      const admin = getUserByName(app.db, PREVIEW_ADMIN)!;
      const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
      const drawn = await iterationsOf({ app, auth: { user: admin } }, repo);
      expect(drawn?.forks.length).toBeGreaterThanOrEqual(4);
      expect(drawn!.forks.filter((f) => f.forkOf !== null).length).toBe(PREVIEW_FORKS.length);
      expect(drawn!.forks.some((f) => f.forkOf === `preview-ada/${PREVIEW_REPO}`)).toBe(true);
      expect(drawn!.forks.filter((f) => f.forkOf !== null).every((f) => f.builds.length > 0)).toBe(true);
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
