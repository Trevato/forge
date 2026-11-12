/**
 * The New app form, end to end: the sentence becomes a plan, a name and a
 * first issue, and the app's own words promise only what the forge does.
 * Split from `apps.test.ts` so each part runs apart (#1798).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { createAgent, listCrew } from "../src/actions/crew.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

import { bakedFiles as scaffoldFiles } from "../src/apps/template.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import {
  appNameJs,
  deriveAppName,
  STOP_WORDS,
} from "../src/web/pages/apps-name.ts";

// Every test here makes a repository (git, scaffold); on a busy check machine
// that outgrows bun's 5 s default, and the hung-plan test spends 3 s waiting
// by design. Red on main from this alone (#2011).
setDefaultTimeout(30_000);

describe("New app: turn the sentence into a plan and pick the crew", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: string;
  let fakeClaude: string;
  let realClaude: string | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-plan-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user.username;

    // A stand-in for `claude --output-format json`: one JSON object on
    // stdout, chosen by a marker in the prompt (which carries the sentence).
    fakeClaude = join(dataDir, "fake-claude");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
args="$*"
case "$args" in
  *HANG-ME*) sleep 30; exit 0 ;;
  *BAD-AGENT*) printf '%s\\n' '{"is_error":false,"result":"{\\"summary\\":\\"nope\\",\\"checklist\\":[\\"x\\"],\\"agent\\":\\"nobody-on-this-forge\\",\\"confidence\\":0.9}"}'; exit 0 ;;
esac
printf '%s\\n' '{"is_error":false,"result":"{\\"summary\\":\\"Build a notes app\\",\\"checklist\\":[\\"Set up storage\\",\\"Add a form\\",\\"Show the list\\"],\\"agent\\":\\"bot\\",\\"confidence\\":0.8}"}'
`,
    );
    chmodSync(fakeClaude, 0o755);
    realClaude = process.env["FORGE_CLAUDE"];
    process.env["FORGE_CLAUDE"] = fakeClaude;
  });

  afterAll(async () => {
    if (realClaude === undefined) delete process.env["FORGE_CLAUDE"];
    else process.env["FORGE_CLAUDE"] = realClaude;
    delete process.env["FORGE_APP_PLAN"];
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a good plan lands its checklist on the first issue and picks the agent", async () => {
    const made = await newApp(app, alice, {
      name: "notes-a",
      description: "Keep a list of notes",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan?.agent).toBe(bot);
    expect(made.value.issue?.assigneeName).toBe(bot);
    expect(made.value.issue?.body).toContain("Build a notes app");
    expect(made.value.issue?.body).toContain("- [ ] Set up storage");
    expect(made.value.issue?.body).toContain("- [ ] Add a form");
  });

  test("a slug already in use is refused before any repository exists", async () => {
    const first = await newApp(app, alice, { name: "held-x" });
    expect(first.ok).toBe(true);
    const second = await newApp(app, alice, { name: "held_x" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("slug_taken");
    expect(getRepo(app.db, alice.username, "held_x")).toBeUndefined();
  });

  test("a plan naming an agent not on the forge is refused; the sentence still opens unassigned", async () => {
    const made = await newApp(app, alice, {
      name: "notes-b",
      description: "BAD-AGENT: pick someone who does not exist",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
    expect(made.value.issue?.body).toBe(
      "BAD-AGENT: pick someone who does not exist",
    );
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  });

  test("a plan that times out still opens the sentence, unassigned", async () => {
    const made = await newApp(app, alice, {
      name: "notes-c",
      description: "HANG-ME: never answer",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  }, 30_000);

  test("FORGE_APP_PLAN=0 behaves exactly as without pickAgent", async () => {
    process.env["FORGE_APP_PLAN"] = "0";
    const made = await newApp(app, alice, {
      name: "notes-d",
      description: "Keep a list of notes",
      pickAgent: true,
    });
    delete process.env["FORGE_APP_PLAN"];
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
  });

  test("no claude on PATH behaves exactly as without pickAgent", async () => {
    const before = process.env["FORGE_CLAUDE"];
    process.env["FORGE_CLAUDE"] = join(dataDir, "no-such-binary");
    const made = await newApp(app, alice, {
      name: "notes-e",
      description: "Keep a list of notes",
      pickAgent: true,
    });
    process.env["FORGE_CLAUDE"] = before;
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
  });

  test('agent: "" — nobody picked — still opens the sentence, unassigned', async () => {
    const made = await newApp(app, alice, {
      name: "notes-f",
      description: "Keep a list of notes",
      agent: "",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.issue?.title).toBe("Build notes-f");
    expect(made.value.issue?.body).toBe("Keep a list of notes");
    expect(made.value.issue?.assigneeName).toBeNull();
    expect(made.value.issue?.state).toBe("open");
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  });

  test("an empty sentence still opens nothing", async () => {
    const made = await newApp(app, alice, { name: "notes-g" });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.issue).toBeUndefined();
  });
});

describe("New app on a forge with no agents at all: the sentence still opens", () => {
  let dataDir: string;
  let app: App;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-noagents-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the sentence opens the first issue, unassigned", async () => {
    const made = await newApp(app, alice, {
      name: "solo",
      description: "Keep a list of notes",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.issue?.title).toBe("Build solo");
    expect(made.value.issue?.body).toBe("Keep a list of notes");
    expect(made.value.issue?.assigneeName).toBeNull();
    expect(made.value.issue?.state).toBe("open");
  });
});

describe("New app: the form asks for the sentence, and names it (issue #60)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-appname-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "nadia",
      email: "nadia@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "nadia",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function submitNewApp(fields: Record<string, string>) {
    return fetch(`${base}/apps/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({
        owner: "",
        name: "",
        visibility: "private",
        agent: "",
        ...fields,
      }),
      redirect: "manual",
    });
  }

  test("a sentence alone creates an app named its slug, articles dropped", async () => {
    const res = await submitNewApp({
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nadia/keep-shared");
  });

  test("a second app from the same sentence gets a distinct name", async () => {
    const res = await submitNewApp({
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nadia/keep-shared-2");
  });

  test("a sentence a slug cannot carry asks for a name, sentence intact", async () => {
    const res = await submitNewApp({ description: "!!! ??? ..." });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("make a name from");
    expect(text).toContain("!!! ??? ...");
  });

  test("an explicit name wins over the derived one", async () => {
    const res = await submitNewApp({
      name: "groceries",
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nadia/groceries");
  });
});

describe("deriveAppName: a sentence yields a short, ordinary name (issue #186)", () => {
  const cases: Array<[string, string | undefined]> = [
    // Leading articles and small connecting words are dropped.
    ["a notepad that counts words", "notepad-counts"],
    ["an app for tracking my plants", "app-tracking"],
    // Already short: nothing to drop.
    ["logs", "logs"],
    // Only stop words: falls back to the window itself, never empty.
    ["the a of it", "the-a"],
    // A script this ASCII slug cannot carry: no usable name.
    ["猫を飼っています", undefined],
    // Punctuation only: unchanged from before.
    ["!!! ??? ...", undefined],
  ];

  for (const [sentence, expected] of cases) {
    test(`${JSON.stringify(sentence)} -> ${JSON.stringify(expected)}`, () => {
      expect(deriveAppName(sentence)).toBe(expected);
    });
  }

  test("appNameJs embeds the same stop words, window and cap as deriveAppName", () => {
    expect(appNameJs).toContain(JSON.stringify(Array.from(STOP_WORDS)));
  });
});

describe("New app lands on the app's page, not the flash (issue #133)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base: string;
  let cookie: string;
  const DOMAIN = "apps.test";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-redirect-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "priya",
      email: "priya@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    const madeAgent = await createAgent(app, created.value, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!madeAgent.ok) throw new Error(String(madeAgent.error));
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "priya",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  });

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("in studio mode, POST /apps/new redirects to the studio's app page, which shows the name, the URL and the first issue", async () => {
    const submitted = await fetch(`${base}/apps/new`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        owner: "priya",
        name: "planner",
        description: "Plan a trip",
        visibility: "private",
        agent: "bot",
      }),
      redirect: "manual",
    });
    expect(submitted.status).toBe(303);
    expect(submitted.headers.get("location")).toBe("/priya/planner");
    const flash = (submitted.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(flash).toStartWith("forge_flash=");

    const landed = await fetch(`${base}${submitted.headers.get("location")}`, {
      headers: { cookie: `${cookie}; ${flash}` },
    });
    expect(landed.status).toBe(200);
    const html = await landed.text();
    expect(html).toContain("planner");
    expect(html).toContain(`planner.${DOMAIN}:${servers.port}`);
    expect(html).toContain("#1 is assigned to bot.");
  });

  test("in dev mode, POST /apps/new redirects to the repository's home, its strip carrying the URL", async () => {
    const submitted = await fetch(`${base}/apps/new`, {
      method: "POST",
      headers: { cookie: `${cookie}; forge_mode=dev`, origin: base },
      body: new URLSearchParams({
        owner: "priya",
        name: "tracker",
        description: "Track expenses",
        visibility: "private",
        agent: "bot",
      }),
      redirect: "manual",
    });
    expect(submitted.status).toBe(303);
    expect(submitted.headers.get("location")).toBe("/priya/tracker");
    const flash = (submitted.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(flash).toStartWith("forge_flash=");

    const landed = await fetch(`${base}${submitted.headers.get("location")}`, {
      headers: { cookie: `${cookie}; forge_mode=dev; ${flash}` },
    });
    expect(landed.status).toBe(200);
    const html = await landed.text();
    expect(html).toContain("tracker");
    expect(html).toContain(`http://tracker.${DOMAIN}:${servers.port}`);
    expect(html).toContain("#1 is assigned to bot.");
  });

  test("a reader who cannot see the app gets the forge's not-found", async () => {
    const anonymous = await fetch(`${base}/priya/planner/app`, {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(404);
  });
});

describe("a new app's own words promise only the check the forge runs (issue #192)", () => {
  const files = scaffoldFiles({
    name: "hello",
    description: "A place for notes",
  });
  const content = (path: string): string => {
    const file = files.find((f) => f.path === path);
    if (file === undefined || typeof file.content !== "string")
      throw new Error(`scaffold has no text file at ${path}`);
    return file.content;
  };

  // A sentence that talks about both "check" and "pull" is a sentence
  // claiming the forge checks the pull — true only when forge.json declares
  // one (`check`), since an app's own `test` runs beside its deploy instead.
  const promisesACheck = (prose: string): boolean =>
    prose
      .split(/(?<=[.!?])\s+/)
      .some(
        (sentence) => /\bcheck/i.test(sentence) && /\bpull/i.test(sentence),
      );

  test("forge.json declares no separate check, and the prose does not claim one", () => {
    const checked = parseCheck(content("forge.json"), content("package.json"));
    expect(checked.ok).toBe(true);
    const declaresCheck = checked.ok && checked.value !== undefined;
    expect(declaresCheck).toBe(false);
    expect(promisesACheck(content("README.md"))).toBe(declaresCheck);
    expect(promisesACheck(content("AGENTS.md"))).toBe(declaresCheck);
  });

  test("the README and AGENTS.md agree on what app.test actually does", () => {
    for (const path of ["README.md", "AGENTS.md"]) {
      expect(content(path)).toContain("app.test");
      expect(content(path)).toMatch(/beside/);
    }
  });
});
