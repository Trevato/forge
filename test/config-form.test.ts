/**
 * Config files as a form (#7336): a JSON file's values as typed fields, a
 * schema's choices and bounds, and a save that writes the file back in its
 * own order and indent — committed by a writer, proposed by anyone else.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createSession } from "../src/core/sessions.ts";
import { getUserByName } from "../src/core/users.ts";
import { getRepo, updateRepoSettings } from "../src/core/repos.ts";
import { createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { signUp } from "../src/actions/users.ts";
import { proposeEditText } from "../src/actions/propose_edit.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { listPulls } from "../src/core/pulls.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { localSource } from "../src/view/local.ts";
import { applyOp, configFields, opValue, readValues } from "../src/web/render/config-form.ts";
import { detectStyle, parseJson, sameDoc, stringify, type Json } from "../src/web/render/json-doc.ts";
import { findSchema, globMatches, validate } from "../src/web/render/json-schema.ts";
import { digestOf, MAX_FORM_BYTES } from "../src/web/pages/config.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { signUpProven } from "./helpers/verified.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const doc = (text: string): Json => {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe("a JSON document, kept exact", () => {
  test("a round trip keeps key order, indent and the final newline", () => {
    for (const text of [
      '{\n  "b": 1,\n  "a": [\n    true,\n    null\n  ],\n  "2": "two",\n  "1": 1.0\n}\n',
      '{\n\t"z": {\n\t\t"y": []\n\t},\n\t"x": {}\n}',
      '{\r\n    "only": "four spaces"\r\n}\r\n',
      '{"compact":[1,2],"x":{"y":"z"}}',
    ])
      expect(stringify(doc(text), detectStyle(text))).toBe(text);
  });

  test("invalid JSON names its line and column", () => {
    const parsed = parseJson('{\n  "a": 1,\n  "b": ,\n}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatchObject({ line: 3, column: 8 });
    expect(parseJson('{"a":1,"a":2}').ok).toBe(false);
  });
});

describe("fields inferred from the values", () => {
  const html = String(
    configFields(
      doc('{"name":"lamp","port":8080,"on":true,"gone":null,"db":{"host":"h"},"tags":["a","b"],"servers":[{"host":"x"},{"host":"y"}]}'),
    ),
  );

  test("each type gets its control", () => {
    expect(html).toMatch(/type="text"[^>]*value="lamp"|value="lamp"[^>]*type="text"/s);
    expect(html).toMatch(/name="v\/port"[^>]*type="number"/);
    expect(html).toMatch(/name="v\/on"[^>]*type="checkbox"\s*value="true"\s*checked/);
    expect(html).toMatch(/name="v\/gone"[^>]*readonly[^>]*value="null"/);
    expect(html).toMatch(/<fieldset class="field config-group"[^>]*>\s*<legend>db<\/legend>/);
    expect(html).toContain('class="config-chips"');
    expect(html).toContain('name="v/tags/1"');
    expect(html.match(/class="config-card"/g)?.length).toBe(2);
    expect(html).toContain('name="v/servers/1/host"');
  });

  test("cards add, remove and move like the boards editor", () => {
    let d = doc('{"servers":[{"host":"x","port":1},{"host":"y","port":2}]}');
    d = applyOp(d, opValue("down", "/servers/0"));
    expect(stringify(d)).toBe('{"servers":[{"host":"y","port":2},{"host":"x","port":1}]}');
    d = applyOp(d, opValue("add", "/servers"));
    expect(stringify(d)).toBe('{"servers":[{"host":"y","port":2},{"host":"x","port":1},{"host":"","port":0}]}');
    d = applyOp(d, opValue("remove", "/servers/0"));
    d = applyOp(d, opValue("up", "/servers/1"));
    expect(stringify(d)).toBe('{"servers":[{"host":"","port":0},{"host":"x","port":1}]}');
    expect(stringify(applyOp(d, "not json"))).toBe(stringify(d));
  });

  test("the form's values write back by type, and a bad number is held, not saved", () => {
    const form: Record<string, string> = { "v/name": "lit", "v/port": "80x", "v/tags/0": "c" };
    const read = readValues(doc('{"name":"lamp","port":8080,"on":true,"tags":["a"]}'), (n) => form[n]);
    expect(stringify(read.doc)).toBe('{"name":"lit","port":8080,"on":false,"tags":["c"]}');
    expect(read.errors.get("/port")).toBe("Must be a number.");
    expect(read.typed.get("/port")).toBe("80x");
  });
});

describe("fields from a schema", () => {
  const schema = {
    root: {
      type: "object",
      required: ["mode", "port"],
      properties: {
        mode: { enum: ["dev", "prod"], description: "Where it runs." },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        name: { type: "string", pattern: "^[a-z]+$" },
        extra: { type: "boolean" },
      },
    },
    from: "app.schema.json",
  };

  test("an enum is a select, a description is help, bounds are attributes", () => {
    const html = String(configFields(doc('{"mode":"dev","port":80,"name":"x"}'), { found: schema }));
    expect(html).toMatch(/<select class="input"[^>]*name="j\/mode"/);
    expect(html).toContain('<option value="&quot;prod&quot;"');
    // Every structural button skips the browser's checks, through btn().
    expect(html.match(/<button[^>]*>/g)!.every((b) => b.includes("formnovalidate"))).toBe(true);
    expect(html).toContain("Where it runs.");
    expect(html).toMatch(/min="1"[\s\S]*max="65535"/);
    expect(html).toContain('pattern="^[a-z]+$"');
    // A property the file lacks is one button away.
    expect(html).toMatch(/>extra\s*<\/button>/);
    // Help text is read with its field.
    expect(html).toMatch(/name="j\/mode"\s*aria-describedby="cf-\d+-hint"/);
  });

  test("required, minimum, maximum and enum are checked on the server too", () => {
    const errors = validate(doc('{"mode":"test","port":70000}'), schema);
    expect(errors.get("/mode")).toContain("one of");
    expect(errors.get("/port")).toBe("Must be at most 65535.");
    expect(validate(doc('{"port":1}'), schema).get("")).toBe("Needs mode.");
    expect(validate(doc('{"mode":"dev","port":1}'), schema).size).toBe(0);
  });

  test("found by $schema, then a sibling, then .forge/schemas.json", async () => {
    const files: Record<string, string> = {
      "conf/s.json": '{"title":"declared"}',
      "conf/app.schema.json": '{"title":"sibling"}',
      ".forge/schemas.json": '{"conf/**/*.json":"schemas/any.json"}',
      "schemas/any.json": '{"title":"mapped"}',
    };
    const read = async (p: string): Promise<string | undefined> => files[p];
    expect((await findSchema("conf/app.json", doc('{"$schema":"./s.json"}'), read))?.from).toBe("conf/s.json");
    expect((await findSchema("conf/app.json", doc("{}"), read))?.from).toBe("conf/app.schema.json");
    expect((await findSchema("conf/deep/x.json", doc("{}"), read))?.from).toBe("schemas/any.json");
    expect(await findSchema("other.json", doc('{"$schema":"https://x.dev/s.json"}'), read)).toBeUndefined();
    expect(globMatches("**/*.json", "a.json")).toBe(true);
    expect(globMatches("conf/**/*.json", "conf/a/b/c.json")).toBe(true);
    expect(globMatches("a?c.json", "abc.json")).toBe(true);
    expect(globMatches("*.json", "a/b.json")).toBe(false);
  });
});

test("a glob a repository wrote cannot stall the forge", () => {
  // As a regular expression this backtracked exponentially: 1.7 s at 30
  // characters of path, doubling every few more. The segment walk is
  // O(glob × path); the bound is only a hang guard.
  const t0 = performance.now();
  expect(globMatches("**a".repeat(66) + "b", `${"a".repeat(60)}.json`)).toBe(false);
  expect(globMatches("*a*a*a*a*a*a*a*a*a*a*a*a*b", `${"a".repeat(200)}.json`)).toBe(false);
  expect(performance.now() - t0).toBeLessThan(5_000);
});

describe("the config form on the web", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base = "";
  let origin = "";
  let alice = "";
  let kim = "";
  const DEPLOY = "# how it runs\nname: lamp # the app\nbase: &b\n  port: 80\nreplicas: 2\n";
  // Hostile shapes a form must refuse, not expand: never past MAX_FORM_BYTES, so read only after the size check.
  const HOSTILE: Record<string, string> = {
    "flow.yml": `a: ${"[".repeat(10_000)}${"]".repeat(10_000)}\n`,
    "merge.yml": `a0: &a0 {x: 1}\n${Array.from({ length: 11 }, (_, i) => `a${i + 1}: &a${i + 1}\n  <<: [${Array(9).fill(`*a${i}`).join(", ")}]`).join("\n")}\n`,
    "deep.toml": `a = ${"[".repeat(70)}${"]".repeat(70)}\n`,
  };
  const SETTINGS = '{\n    "name": "lamp",\n    "port": 8080,\n    "tags": [\n        "a"\n    ]\n}\n';

  const get = (path: string, cookie = ""): Promise<Response> =>
    fetch(`${base}${path}`, { redirect: "manual", ...(cookie === "" ? {} : { headers: { cookie } }) });
  const post = (path: string, fields: Record<string, string>, cookie = ""): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { origin, ...(cookie === "" ? {} : { cookie }) },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const fileAt = async (owner: string, name: string, ref: string, path: string): Promise<string | undefined> => {
    const repo = getRepo(app.db, owner, name)!;
    const blob = await localSource(app, repo, undefined).blob(ref, path);
    return blob.ok && blob.value.kind === "text" ? new TextDecoder().decode(blob.value.body) : undefined;
  };
  const commitCount = async (owner: string, name: string): Promise<number> => {
    const proc = Bun.spawn(["git", "rev-list", "--count", "main"], {
      cwd: repoDir(app.reposRoot, owner, name),
      env: gitClientEnv(),
      stdout: "pipe",
    });
    return Number((await new Response(proc.stdout).text()).trim());
  };
  const save = (repo: string, edited: string, cookie: string, before = SETTINGS): Promise<Response> =>
    post(`/alice/${repo}/config`, {
      ref: "main",
      path: "settings.json",
      base: digestOf(before),
      doc: edited,
      step: "save",
      message: "Port 9090",
    }, cookie);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-config-form-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    origin = new URL(base).origin;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-config-passphrase" });
    const k = await signUpProven(app, { username: "kim", email: "k@f.dev", password: "a-long-config-passphrase" });
    if (!a.ok || !k.ok) throw new Error("signup failed");
    // A fork is a member's: a guest's proposal is refused before it starts.
    if (!setRole(app, a.value, "kim", "member").ok) throw new Error("role failed");
    alice = `forge_session=${createSession(app.db, a.value.id).token}`;
    kim = `forge_session=${createSession(app.db, k.value.id).token}`;
    for (const [name, visibility] of [["lamp", "public"], ["vault", "private"]] as const) {
      const made = await createRepo(app, a.value, { name, visibility });
      if (!made.ok) throw new Error("repo failed");
      await commitToBranch(app, a.value, made.value, {
        message: "first",
        files: [
          { path: "settings.json", content: SETTINGS },
          { path: "broken.json", content: '{\n  "a": 1,\n  oops\n}\n' },
          { path: "deploy.yml", content: DEPLOY },
          ...Object.entries(HOSTILE).map(([path, content]) => ({ path, content })),
        ],
      });
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the blob page draws a JSON file as a form, with Source and Edit as form one click away", async () => {
    const html = await (await get("/alice/lamp/blob/main/settings.json")).text();
    expect(html).toContain('class="card config-form"');
    expect(html).toContain("?view=source");
    expect(html).toContain('href="/alice/lamp/config/main/settings.json"');
    const source = await (await get("/alice/lamp/blob/main/settings.json?view=source")).text();
    expect(source).not.toContain('class="card config-form"');
  });

  test("the editor is a plain form that posts", async () => {
    const res = await get("/alice/lamp/config/main/settings.json", alice);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/alice/lamp/config"');
    expect(html).toContain('name="v/port"');
    expect(html).toContain("Review changes");
    // A reader is offered the proposal, not the commit.
    expect(await (await get("/alice/lamp/config/main/settings.json", kim)).text()).toContain("Review and propose");
  });

  test("review shows the diff, and a no-op writes nothing", async () => {
    const fields = { ref: "main", path: "settings.json", base: digestOf(SETTINGS), doc: stringify(doc(SETTINGS)), from: "form", "v/name": "lamp", "v/port": "9090", "v/tags/0": "a", step: "review" };
    const review = await (await post("/alice/lamp/config", fields, alice)).text();
    expect(review).toContain('data-op="del">-     &quot;port&quot;: 8080,');
    expect(review).toContain('data-op="add">+     &quot;port&quot;: 9090,');
    expect(review).toContain("Commit to main");

    const before = await commitCount("alice", "lamp");
    const same = await (await post("/alice/lamp/config", { ...fields, "v/port": "8080" }, alice)).text();
    expect(same).toContain("Nothing changed");
    const again = await save("lamp", stringify(doc(SETTINGS)), alice);
    expect(again.status).toBe(200);
    expect(await commitCount("alice", "lamp")).toBe(before);
  });

  test("a writer's save makes one commit, in the file's own order and indent", async () => {
    const before = await commitCount("alice", "lamp");
    const res = await save("lamp", '{"name":"lamp","port":9090,"tags":["a"]}', alice);
    expect(res.status).toBe(303);
    expect(await commitCount("alice", "lamp")).toBe(before + 1);
    expect(await fileAt("alice", "lamp", "main", "settings.json")).toBe(SETTINGS.replace("8080", "9090"));
  });

  test("a save over a file that moved since it was opened is held", async () => {
    const res = await save("lamp", '{"name":"lamp","port":1,"tags":["a"]}', alice);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("changed on main since you opened it");
  });

  test("a reader's save opens a pull from their fork", async () => {
    const current = (await fileAt("alice", "lamp", "main", "settings.json"))!;
    const res = await save("lamp", '{"name":"kim","port":9090,"tags":["a"]}', kim, current);
    expect(res.status).toBe(303);
    const upstream = getRepo(app.db, "alice", "lamp")!;
    const pulls = listPulls(app.db, upstream.id, { state: "open" });
    expect(pulls.length).toBe(1);
    expect(res.headers.get("location")).toBe(`/alice/lamp/pulls/${pulls[0]!.number}`);
    expect(pulls[0]!.headRepoId).toBe(getRepo(app.db, "kim", "lamp")!.id);
    // Nothing landed on the branch the reader cannot push to.
    expect(await fileAt("alice", "lamp", "main", "settings.json")).toBe(current);
  });

  test("a YAML file opens as a form and a save keeps its comments and anchors", async () => {
    const page = await (await get("/alice/lamp/blob/main/deploy.yml")).text();
    expect(page).toContain('class="card config-form"');
    expect(page).toContain('href="/alice/lamp/config/main/deploy.yml"');
    const form = await (await get("/alice/lamp/config/main/deploy.yml", alice)).text();
    expect(form).toContain('name="v/replicas"');
    // A plain form post: nothing here needs a script.
    expect(form).toContain('<form method="post" action="/alice/lamp/config" class="config-form">');
    const before = await commitCount("alice", "lamp");
    const res = await post("/alice/lamp/config", {
      ref: "main",
      path: "deploy.yml",
      base: digestOf(DEPLOY),
      doc: '{"name":"lamp","base":{"port":80},"replicas":3}',
      step: "save",
      message: "Three replicas",
    }, alice);
    expect(res.status).toBe(303);
    expect(await commitCount("alice", "lamp")).toBe(before + 1);
    expect(await fileAt("alice", "lamp", "main", "deploy.yml")).toBe(DEPLOY.replace("replicas: 2", "replicas: 3"));
  });

  test("hostile YAML and TOML fall back to the source on the page and are refused on submit", async () => {
    for (const [path, content] of Object.entries(HOSTILE)) {
      const res = await get(`/alice/lamp/config/main/${path}`, alice);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain(`/alice/lamp/blob/main/${path}?view=source`);
      const before = await commitCount("alice", "lamp");
      const sub = await post("/alice/lamp/config", {
        ref: "main",
        path,
        base: digestOf(content),
        doc: '{"a":1}',
        step: "save",
        message: "Nope",
      }, alice);
      expect(sub.status).toBe(303);
      expect(sub.headers.get("location")).toContain(`?view=source`);
      expect(await commitCount("alice", "lamp")).toBe(before);
    }
  });

  test("a file over MAX_FORM_BYTES is refused before it is parsed, on the page and on submit", async () => {
    const big = `# ${"x".repeat(MAX_FORM_BYTES)}\na: 1\n`;
    const made = await commitToBranch(app, getUserByName(app.db, "alice")!, getRepo(app.db, "alice", "lamp")!, {
      message: "big",
      files: [{ path: "big.yml", content: big }],
    });
    expect(made.ok).toBe(true);
    const page = await get("/alice/lamp/config/main/big.yml", alice);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toContain("?view=source");
    const sub = await post("/alice/lamp/config", { ref: "main", path: "big.yml", base: digestOf(big), doc: '{"a":2}', step: "save", message: "x" }, alice);
    expect(sub.status).not.toBe(200);
    expect(await fileAt("alice", "lamp", "main", "big.yml")).toBe(big);
  });

  test("invalid JSON falls back to the source with the error and its line", async () => {
    const blob = await (await get("/alice/lamp/blob/main/broken.json")).text();
    expect(blob).toContain("Not valid JSON");
    expect(blob).toContain("at line 3, column 3");
    const res = await get("/alice/lamp/config/main/broken.json", alice);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/alice/lamp/blob/main/broken.json?view=source");
  });

  test("a private repository's file is not editable signed out", async () => {
    expect((await get("/alice/vault/config/main/settings.json")).status).toBe(404);
    expect((await save("vault", '{"name":"x"}', "")).status).toBe(404);
    expect((await get("/alice/vault/config/main/settings.json", kim)).status).toBe(404);
    expect(await fileAt("alice", "vault", "main", "settings.json")).toBe(SETTINGS);
  });

  test("the hidden document is equal to the one drawn", () => {
    expect(sameDoc(doc(SETTINGS), doc(stringify(doc(SETTINGS))))).toBe(true);
  });
});

describe("who commits and who proposes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base = "";
  let origin = "";
  const cookies: Record<string, string> = {};
  const SETTINGS = '{\n  "port": 8080,\n  "tags": [\n    "a"\n  ]\n}\n';

  const post = (path: string, fields: Record<string, string>, cookie: string): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { origin, cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const save = (repo: string, cookie: string): Promise<Response> =>
    post(`/${repo}/config`, {
      ref: "main",
      path: "settings.json",
      base: digestOf(SETTINGS),
      doc: '{"port":9090,"tags":["a"]}',
      step: "save",
      message: "Port 9090",
    }, cookie);
  const mainText = async (owner: string, name: string): Promise<string | undefined> => {
    const blob = await localSource(app, getRepo(app.db, owner, name)!, undefined).blob("main", "settings.json");
    return blob.ok && blob.value.kind === "text" ? new TextDecoder().decode(blob.value.body) : undefined;
  };
  const session = (id: string): string => `forge_session=${createSession(app.db, id).token}`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-config-who-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    origin = new URL(base).origin;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-config-passphrase" });
    const dev = await signUpProven(app, { username: "dev", email: "d@f.dev", password: "a-long-config-passphrase" });
    const gus = await signUpProven(app, { username: "gus", email: "g@f.dev", password: "a-long-config-passphrase" });
    const una = await signUp(app, { username: "una", email: "u@f.dev", password: "a-long-config-passphrase" }, { slot: fixtureSlot(app) });
    if (!a.ok || !dev.ok || !gus.ok || !una.ok) throw new Error("users failed");
    const agent = await createAgent(app, a.value, { username: "bot", brief: "Be brief." });
    if (!agent.ok) throw new Error(String(agent.error));
    const bot = { value: agent.value.user };
    for (const [name, user] of [["alice", a], ["dev", dev], ["gus", gus], ["una", una], ["bot", bot]] as const)
      cookies[name] = session(user.value.id);

    const org = createOrg(app.db, "acme", a.value.id);
    if (!org.ok) throw new Error("org failed");
    const writers = createTeam(app.db, org.value.id, "Writers", "write");
    if (!writers.ok) throw new Error("team failed");
    addTeamMember(app.db, writers.value, dev.value.id);
    // An agent with write access as a person would have it: on a write team.
    addTeamMember(app.db, writers.value, bot.value.id);

    for (const [owner, name] of [["alice", "lamp"], ["acme", "tower"], ["acme", "dock"]] as const) {
      const made = await createRepo(app, a.value, { owner, name, visibility: "public" });
      if (!made.ok) throw new Error(`repo failed: ${String(made.error)}`);
      await commitToBranch(app, a.value, made.value, { message: "first", files: [{ path: "settings.json", content: SETTINGS }] });
    }
    updateRepoSettings(app.db, getRepo(app.db, "acme", "tower")!, { protectDefault: true });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an agent with write access proposes, on a branch of the repository itself", async () => {
    const page = await (await fetch(`${base}/acme/dock/config/main/settings.json`, { headers: { cookie: cookies.bot! } })).text();
    expect(page).toContain("Review and propose");
    const res = await save("acme/dock", cookies.bot!);
    expect(res.status).toBe(303);
    const dock = getRepo(app.db, "acme", "dock")!;
    const pulls = listPulls(app.db, dock.id, { state: "open" });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.headRepoId ?? dock.id).toBe(dock.id);
    expect(await mainText("acme", "dock")).toBe(SETTINGS);
    // A person on the same team, on the same unprotected branch, commits.
    const direct = await save("acme/dock", cookies.dev!);
    expect(direct.headers.get("location")).toBe("/acme/dock/blob/main/settings.json");
  });

  test("a writer who is not an admin, on a protected default, proposes inside the repository", async () => {
    const res = await save("acme/tower", cookies.dev!);
    expect(res.status).toBe(303);
    const tower = getRepo(app.db, "acme", "tower")!;
    const pulls = listPulls(app.db, tower.id, { state: "open" });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.headRepoId ?? tower.id).toBe(tower.id);
    expect(getRepo(app.db, "dev", "tower")).toBeUndefined();
    expect(await mainText("acme", "tower")).toBe(SETTINGS);
  });

  test("a guest and an unconfirmed account hear why their proposal could not be made", async () => {
    const guest = await (await save("alice/lamp", cookies.gus!)).text();
    expect(guest).toContain(proposeEditText({ step: "fork", reason: "guest_cooldown" }));
    const unconfirmed = await (await save("alice/lamp", cookies.una!)).text();
    expect(unconfirmed).toContain("Confirm your email first");
    expect(getRepo(app.db, "gus", "lamp")).toBeUndefined();
  });

  test("a signed-in stranger to a private repository gets 404 on the POST", async () => {
    const alice = getRepo(app.db, "alice", "lamp")!;
    updateRepoSettings(app.db, alice, { visibility: "private" });
    try {
      expect((await save("alice/lamp", cookies.gus!)).status).toBe(404);
    } finally {
      updateRepoSettings(app.db, getRepo(app.db, "alice", "lamp")!, { visibility: "public" });
    }
  });

  test("a card button posted as a form comes back with the change, and saves nothing", async () => {
    const form = (op: string, doc: string, values: Record<string, string>) =>
      post("/alice/lamp/config", { ref: "main", path: "settings.json", base: digestOf(SETTINGS), doc, from: "form", op, ...values }, cookies.alice!);
    const added = await (await form(opValue("add", "/tags"), '{"port":8080,"tags":["a"]}', { "v/port": "7", "v/tags/0": "a" })).text();
    expect(added).toContain('name="v/tags/1"');
    // The value typed beside the button rode along into the new form.
    expect(added).toMatch(/name="v\/port"[^>]*value="7"/);
    const removed = await (await form(opValue("remove", "/tags/0"), '{"port":8080,"tags":["a","b"]}', { "v/port": "8080", "v/tags/0": "a", "v/tags/1": "b" })).text();
    expect(removed).toMatch(/name="v\/tags\/0"[^>]*value="b"/);
    expect(removed).not.toContain('name="v/tags/1"');
    expect(await mainText("alice", "lamp")).toBe(SETTINGS);
  });
});
