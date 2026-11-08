/**
 * Absorb: an app declares a `feature` in forge.json, a site admin
 * absorbs it, and the forge keeps its typed settings and hands them to the
 * app's process as FORGE_SETTING_*. Held here: the declaration is fail-closed;
 * declaring alone does nothing; only a site admin absorbs or changes settings
 * (a repository's own admin is refused, a stranger learns nothing); a value
 * that does not fit changes nothing; un-absorbing keeps the values for the
 * next absorb; and an app is told only names a feature owns.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statements } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";
import { createApp, type App } from "../src/app.ts";
import { absorbApp, acceptDeclaration, declaresFeature, absorbedForNav, declaredFeature, changeFeatureSettings, getFeature, unabsorbApp } from "../src/actions/features.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { checkSetting, featureEnv, parseFeature, settingEnvName } from "../src/apps/feature.ts";
import { featureVarsAt } from "../src/apps/feature_env.ts";
import { appEnv } from "../src/apps/process.ts";
import { createApp as insertApp, deleteApp } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import { absorb, featureSettings, getAbsorbed } from "../src/core/features.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { eventVerb } from "../src/design/activity.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const FEATURE = {
  name: "Radar",
  summary: "What the platform runs against what exists",
  page: "/",
  settings: {
    runDays: { type: "days", default: ["mon", "thu"], label: "Run on" },
    runHourUtc: { type: "int", default: 13, min: 0, max: 23, label: "Hour (UTC)" },
    claudeCode: { type: "choice", choices: ["stable", "latest"], default: "latest", label: "Claude Code follows" },
    scout: { type: "bool", default: true, label: "Search the web for ideas" },
  },
};
const FORGE_JSON = JSON.stringify({ app: { run: "bun run src/server.ts" }, feature: FEATURE });

describe("the declaration", () => {
  test("a good one parses, with each default kept as canonical text", () => {
    const parsed = parseFeature(JSON.parse(FORGE_JSON));
    if (!parsed.ok || parsed.value === undefined) throw new Error(JSON.stringify(parsed));
    expect(parsed.value.name).toBe("Radar");
    expect(parsed.value.settings.map((s) => [s.key, s.default])).toEqual([
      ["runDays", "mon,thu"],
      ["runHourUtc", "13"],
      ["claudeCode", "latest"],
      ["scout", "true"],
    ]);
  });

  test("none is no feature, not an error", () => {
    expect(parseFeature({ app: { run: "x" } })).toEqual({ ok: true, value: undefined });
  });

  test("a wrong one is refused with the field named, never guessed", () => {
    const wrong = (feature: unknown) => {
      const r = parseFeature({ feature });
      return r.ok ? "ok" : r.error;
    };
    expect(wrong("Radar")).toContain("must be an object");
    expect(wrong({ name: "" })).toContain("name");
    expect(wrong({ name: "R", page: "https://evil.example/" })).toContain("page");
    expect(wrong({ name: "R", page: "//evil.example" })).toContain("page");
    expect(wrong({ name: "R", extra: 1 })).toContain("unknown field extra");
    expect(wrong({ name: "R", settings: { RunDays: { type: "days" } } })).toContain("camelCase");
    expect(wrong({ name: "R", settings: { a: { type: "secret" } } })).toContain("type is one of");
    expect(wrong({ name: "R", settings: { h: { type: "int", min: 5, max: 1 } } })).toContain("min is above max");
    expect(wrong({ name: "R", settings: { h: { type: "int", default: 30, max: 23 } } })).toContain("default is at most 23");
    expect(wrong({ name: "R", settings: { c: { type: "choice", choices: ["only"] } } })).toContain("choices");
    expect(wrong({ name: "R", settings: { s: { type: "string", min: 1 } } })).toContain("only an int");
    // Two keys that would be one environment variable (both FORGE_SETTING_A_BC).
    expect(wrong({ name: "R", settings: { aBC: { type: "bool" }, aBc: { type: "bool" } } })).toContain("share one FORGE_SETTING_ name");
    expect(wrong({ name: "R", settings: { a_b: { type: "bool" } } })).toContain("camelCase");
  });

  test("values are checked by type, and kept in one form", () => {
    expect(checkSetting({ type: "days" }, ["Thursday", "mon"])).toEqual({ ok: true, value: "mon,thu" });
    expect(checkSetting({ type: "days" }, "fri,mon")).toEqual({ ok: true, value: "mon,fri" });
    expect(checkSetting({ type: "days" }, ["someday"]).ok).toBe(false);
    expect(checkSetting({ type: "bool" }, "on")).toEqual({ ok: true, value: "true" });
    expect(checkSetting({ type: "bool" }, "yes").ok).toBe(false);
    expect(checkSetting({ type: "int", min: 0, max: 23 }, "24").ok).toBe(false);
    expect(checkSetting({ type: "int" }, "1e3").ok).toBe(false);
    expect(checkSetting({ type: "list" }, "a\nb, c")).toEqual({ ok: true, value: "a,b,c" });
    expect(checkSetting({ type: "string" }, "line\u0007bell").ok).toBe(false);
    expect(checkSetting({ type: "choice", choices: ["a", "b"] }, "c").ok).toBe(false);
  });

  test("the process is told every setting: kept, else default, and a kept value that no longer fits is the default", () => {
    const parsed = parseFeature(JSON.parse(FORGE_JSON));
    if (!parsed.ok || parsed.value === undefined) throw new Error("no feature");
    const env = featureEnv(parsed.value, new Map([["runHourUtc", "99"], ["scout", "false"], ["gone", "x"]]));
    expect(env).toEqual({
      FORGE_FEATURE: "1",
      FORGE_SETTING_RUN_DAYS: "mon,thu",
      FORGE_SETTING_RUN_HOUR_UTC: "13",
      FORGE_SETTING_CLAUDE_CODE: "latest",
      FORGE_SETTING_SCOUT: "false",
    });
    expect(settingEnvName("runHourUtc")).toBe("FORGE_SETTING_RUN_HOUR_UTC");
  });

  test("an app is told only names a feature owns, never one the forge sets itself", () => {
    const env = appEnv({
      port: 4000,
      dataDir: "/data",
      env: "production",
      url: "http://radar.test",
      commitOid: "abc",
      forgeUrl: "http://forge.test",
      identityKey: "k",
      feature: { FORGE_SETTING_RUN_DAYS: "mon", PORT: "1", FORGE_APP_DATA: "/etc", FORGE_TOKEN: "stolen", FORGE_FEATURE: "1" },
    });
    expect(env["FORGE_SETTING_RUN_DAYS"]).toBe("mon");
    expect(env["FORGE_FEATURE"]).toBe("1");
    expect(env["PORT"]).toBe("4000");
    expect(env["FORGE_APP_DATA"]).toBe("/data");
    expect(env["FORGE_TOKEN"]).toBeUndefined();
  });
});

describe("absorbing an app", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let ada: User; // site admin
  let bob: User; // a stranger to the repository
  let cy: User; // owns the repository, no site admin
  let repo: Repo;
  let appId = "";
  let adaToken = "";
  let adaReadToken = "";
  let bobToken = "";
  let cyToken = "";
  let adaCookie = "";
  let cyCookie = "";

  const api = (method: string, token: string, path: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1/features${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };
  const web = (cookie: string, path: string, form?: URLSearchParams) =>
    fetch(`${servers.url}${path}`, {
      method: form === undefined ? "GET" : "POST",
      headers: { cookie, origin: servers.url },
      redirect: "manual",
      ...(form === undefined ? {} : { body: form }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-features-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    bob = await make("bob");
    cy = await make("cy");
    promote(app.db, cy);
    const made = await createRepo(app, cy, { name: "radar", visibility: "private", description: "" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const committed = await commitToBranch(app, cy, repo, {
      message: "Radar can be a feature",
      files: [{ path: "forge.json", content: FORGE_JSON }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const row = insertApp(app.db, { repoId: repo.id, slug: "radar", access: "private" });
    if (!row.ok) throw new Error(row.error);
    appId = row.value.id;
    adaToken = createToken(app.db, ada.id, "admin", "admin").token;
    adaReadToken = createToken(app.db, ada.id, "read", "ro").token;
    bobToken = createToken(app.db, bob.id, "admin", "admin").token;
    cyToken = createToken(app.db, cy.id, "admin", "admin").token;
    adaCookie = await signIn("ada");
    cyCookie = await signIn("cy");
  }, 60_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("declaring is not absorbing: nothing is in the nav and the app is told nothing", async () => {
    expect(getAbsorbed(app.db, appId)).toBeUndefined();
    expect(absorbedForNav(app, ada)).toEqual([]);
    expect(featureVarsAt(app.db, appId, FORGE_JSON)).toEqual({});
    const seen = await getFeature(app, cy, "radar");
    expect(seen.ok && seen.value.absorbed).toBe(false);
  });

  test("an admin sees Features on the page of a declaring app that is not absorbed; nobody else does", async () => {
    expect(getAbsorbed(app.db, appId)).toBeUndefined();
    const link = 'href="/settings/features/radar"';
    expect(await (await web(adaCookie, "/cy/radar/files")).text()).toContain(link);
    // The owner reads the page, but is no site admin.
    const owned = await web(cyCookie, "/cy/radar/files");
    expect(owned.status).toBe(200);
    expect(await owned.text()).not.toContain(link);
    const made0 = await createUser(app.db, { origin: "seed", trusted: true, username: "pixel", email: "pixel@forge.local", password: "a-good-passphrase" });
    if (!made0.ok) throw new Error(made0.error);
    const bot = made0.value;
    promote(app.db, bot);
    // An agent, even one holding the admin flag, is not offered it.
    app.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE id = ?1").run(bot.id);
    const botToken = createToken(app.db, bot.id, "read", "ro").token;
    const asBot = await fetch(`${servers.url}/cy/radar/files`, { headers: { authorization: `Bearer ${botToken}` } });
    const botBody = await asBot.text();
    expect({ status: asBot.status, link: botBody.includes(link) }).toEqual({ status: 200, link: false });
    expect(botBody).toContain("app-strip");
    const agent = { ...ada, kind: "agent" as const };
    expect(await declaresFeature(app, agent, repo)).toBe(false);
    expect(await declaresFeature(app, ada, repo)).toBe(true);
    expect(await declaresFeature(app, undefined, repo)).toBe(false);
    // An app whose forge.json declares none has no link.
    const plain = await createRepo(app, cy, { name: "bare", visibility: "private", description: "" });
    if (!plain.ok) throw new Error(String(plain.error));
    await commitToBranch(app, cy, plain.value, { message: "plain", files: [{ path: "forge.json", content: JSON.stringify({ app: { run: "x" } }) }] });
    const made = insertApp(app.db, { repoId: plain.value.id, slug: "bare", access: "private" });
    if (!made.ok) throw new Error(made.error);
    const page = await web(adaCookie, "/cy/bare/files");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("/settings/features/bare");
  });

  test("only a site admin absorbs: the repository's own admin is refused, a stranger learns nothing", async () => {
    const byOwner = await absorbApp(app, cy, "radar");
    expect(!byOwner.ok && byOwner.error).toBe("forbidden");
    expect((await api("PUT", cyToken, "/radar")).status).toBe(403);
    expect((await api("PUT", bobToken, "/radar")).status).toBe(404);
    expect((await api("GET", bobToken, "/radar")).status).toBe(404);
    expect((await api("GET", cyToken, "")).status).toBe(404);
    // A read-scope token of the admin may look, not absorb.
    expect((await api("PUT", adaReadToken, "/radar")).status).toBe(403);
    expect((await web(cyCookie, "/settings/features")).status).toBe(404);
    expect((await web(cyCookie, "/settings/features/radar/absorb", new URLSearchParams())).status).toBe(404);
    expect(getAbsorbed(app.db, appId)).toBeUndefined();
  });

  test("an app that declares no feature cannot be absorbed", async () => {
    const plain = await createRepo(app, cy, { name: "plain", visibility: "public", description: "" });
    if (!plain.ok) throw new Error("no repo");
    const row = insertApp(app.db, { repoId: plain.value.id, slug: "plain", access: "public" });
    if (!row.ok) throw new Error(row.error);
    expect((await api("PUT", adaToken, "/plain")).status).toBe(422);
    expect(getAbsorbed(app.db, row.value.id)).toBeUndefined();
  });

  test("a site admin absorbs it: an event, a nav entry for its readers only", async () => {
    const res = await api("PUT", adaToken, "/radar");
    expect(res.status).toBe(200);
    const view = (await res.json()) as { absorbed: boolean; name: string };
    expect(view).toMatchObject({ absorbed: true, name: "Radar" });
    expect(absorbedForNav(app, ada).map((f) => f.name)).toEqual(["Radar"]);
    expect(absorbedForNav(app, cy).map((f) => f.name)).toEqual(["Radar"]);
    expect(absorbedForNav(app, bob)).toEqual([]); // absorbing widens nothing
    const events = listEvents(app.db, { repoId: repo.id }).filter((e) => e.kind === "app.absorbed");
    expect(events).toHaveLength(1);
    expect(eventVerb(events[0]!)).toContain("absorbed Radar");
    // Absorbing again changes nothing, and says nothing new.
    expect((await api("PUT", adaToken, "/radar")).status).toBe(200);
    expect(listEvents(app.db, { repoId: repo.id }).filter((e) => e.kind === "app.absorbed")).toHaveLength(1);
    // The menu names it (with no runtime here, it opens the app's own page).
    const home = await (await web(adaCookie, "/settings")).text();
    expect(home).toMatch(/href="\/cy\/radar"[^>]*>[\s\S]{0,400}Radar/);
    const strangers = await (await web(await signIn("bob"), "/settings")).text();
    expect(strangers).not.toContain("Radar");
  });

  test("a production push that renames the feature leaves the menu unchanged until an admin accepts", async () => {
    const renamed = JSON.stringify({ app: { run: "x" }, feature: { ...FEATURE, name: "Radar Pro", page: "/pro" } });
    featureVarsAt(app.db, appId, renamed);
    expect(absorbedForNav(app, ada).map((f) => [f.name, f.page])).toEqual([["Radar", "/"]]);
    const c = await commitToBranch(app, cy, repo, { message: "rename", files: [{ path: "forge.json", content: renamed }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const view = await getFeature(app, ada, "radar");
    expect(view.ok && view.value.pending).toEqual({ name: "Radar Pro", page: "/pro" });
    expect(view.ok && view.value.name).toBe("Radar");
    const list = await (await web(adaCookie, "/settings/features")).text();
    expect(list).toContain("declaration changed: review");
    // The owner is not a site admin; only an admin accepts.
    const refused = await acceptDeclaration(app, cy, "radar", { name: "Radar Pro", page: "/pro" });
    expect(!refused.ok && refused.error).toBe("forbidden");
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar");
    expect((await web(adaCookie, "/settings/features/radar/accept", new URLSearchParams({ name: "Radar Pro", page: "/pro" }))).status).toBe(303);
    expect(absorbedForNav(app, ada).map((f) => [f.name, f.page])).toEqual([["Radar Pro", "/pro"]]);
    expect(listEvents(app.db, { repoId: repo.id }).filter((e) => e.kind === "app.feature_declared")).toHaveLength(1);
    // Back to the original, accepted the same way.
    await commitToBranch(app, cy, repo, { message: "back", files: [{ path: "forge.json", content: FORGE_JSON }] });
    await acceptDeclaration(app, ada, "radar", { name: "Radar", page: "/" });
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar");
  });

  test("accepting what the admin reviewed is refused when production declared something else since", async () => {
    const declare = (name: string) =>
      commitToBranch(app, cy, repo, { message: name, files: [{ path: "forge.json", content: JSON.stringify({ app: { run: "x" }, feature: { ...FEATURE, name } }) }] });
    await declare("Reviewed");
    await declare("Sneaky");
    const stale = await acceptDeclaration(app, ada, "radar", { name: "Reviewed", page: FEATURE.page });
    expect(!stale.ok && stale.error).toBe("declaration_changed");
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar");
    const res = await web(adaCookie, "/settings/features/radar/accept", new URLSearchParams({ name: "Reviewed", page: FEATURE.page }));
    expect(res.status).toBe(303);
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar");
    const fresh = await acceptDeclaration(app, ada, "radar", { name: "Sneaky", page: FEATURE.page });
    expect(fresh.ok).toBe(true);
    await commitToBranch(app, cy, repo, { message: "back", files: [{ path: "forge.json", content: FORGE_JSON }] });
    await acceptDeclaration(app, ada, "radar", { name: "Radar", page: "/" });
  });

  test("the terminal accepts under the page's rules: admin only, and what the screen showed", async () => {
    const { featuresScreen, entry } = await import("../src/tui/screens/features.ts");
    const { Screen: Surface } = await import("../src/tui/term/screen.ts");
    const { theme } = await import("../src/tui/ui/theme.ts");
    const declare = (name: string) =>
      commitToBranch(app, cy, repo, { message: name, files: [{ path: "forge.json", content: JSON.stringify({ app: { run: "x" }, feature: { ...FEATURE, name } }) }] });
    await declare("Radar TUI");
    const toasts: string[] = [];
    const ctx = { theme: theme("dark"), invalidate() {}, push() {}, pop() {}, copy() {}, toast: (m: string) => toasts.push(m) } as never;
    const open = async (user: typeof ada | typeof cy) => {
      const screen = featuresScreen({ app, db: app.db, user } as never, ctx);
      await screen.busy();
      return screen;
    };
    expect(entry.offered({ app, db: app.db, user: cy } as never)).toBe(false);
    expect(entry.offered({ app, db: app.db, user: ada } as never)).toBe(true);
    const shown = new Surface(110, 20);
    (await open(ada)).render({ x: 0, y: 0, w: 110, h: 20 }, shown);
    expect(shown.toText()).toContain("Radar TUI");
    const denied = await open(cy);
    expect(denied.key!({ key: "a" } as never)).toBe(false);
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar");
    const screen = await open(ada);
    // The app declares something else after the screen was read.
    await declare("Radar Later");
    expect(screen.key!({ key: "a" } as never)).toBe(true);
    await screen.busy();
    expect(toasts.at(-1)).toContain("review it again");
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar");
    const again = await open(ada);
    expect(again.key!({ key: "a" } as never)).toBe(true);
    await again.busy();
    expect(absorbedForNav(app, ada)[0]!.name).toBe("Radar Later");
    await commitToBranch(app, cy, repo, { message: "back", files: [{ path: "forge.json", content: FORGE_JSON }] });
    await acceptDeclaration(app, ada, "radar", { name: "Radar", page: "/" });
  });

  test("every label in the forge's own menus is one a feature may not take", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/web/layout.ts", import.meta.url), "utf8");
    const labels = [...src.matchAll(/\blabel: "([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(15);
    for (const l of labels) expect({ l, refused: !parseFeature({ feature: { name: l } }).ok }).toEqual({ l, refused: true });
  });

  test("the menu groups feature entries under their own heading, and a built-in label is refused", async () => {
    const home = await (await web(adaCookie, "/settings")).text();
    expect(home).toMatch(/menu-title">Features from apps<\/span>[\s\S]*Radar/);
    for (const name of ["Sign out", "admin", "  SIGN-OUT ", "Ｓettings"]) expect(parseFeature({ feature: { name } }).ok).toBe(false);
    expect(parseFeature({ feature: { name: "Settings" } }).ok).toBe(false);
  });

  test("a value that does not fit changes nothing, and names the setting", async () => {
    const res = await api("PATCH", adaToken, "/radar/settings", { settings: { runDays: ["mon"], runHourUtc: 30 } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain("Hour (UTC) is at most 23");
    const unknown = await changeFeatureSettings(app, ada, "radar", { notASetting: 1 });
    expect(!unknown.ok && unknown.error.error).toBe("invalid_setting");
    expect(featureSettings(app.db, appId).size).toBe(0);
    const byOwner = await changeFeatureSettings(app, cy, "radar", { runHourUtc: 9 });
    expect(!byOwner.ok && byOwner.error.error).toBe("forbidden");
  });

  test("a refused save keeps what was typed and marks the field; the menu and strip say more", async () => {
    const form = new URLSearchParams([
      ["s.runDays", "tue"],
      ["s.runHourUtc", "99"],
      ["s.claudeCode", "stable"],
    ]);
    const refused = await web(adaCookie, "/settings/features/radar", form);
    expect(refused.status).toBe(422);
    const page = await refused.text();
    expect(page).toContain('value="99"');
    expect(page).toContain("Hour (UTC) is at most 23");
    expect(page).toContain('aria-invalid="true"');
    // The switch says what it does before it is pressed.
    const list = await (await web(adaCookie, "/settings/features")).text();
    expect(list).toContain("Un-absorbing takes Radar off every menu");
    // The app's own page links to Features for an admin.
    expect(await (await web(adaCookie, "/cy/radar/files")).text()).toContain('href="/settings/features/radar"');
  });

  test("good values are kept and reach the app as FORGE_SETTING_*", async () => {
    const res = await api("PATCH", adaToken, "/radar/settings", { settings: { runDays: ["wed", "mon", "fri"], runHourUtc: 9 } });
    expect(res.status).toBe(200);
    expect(featureVarsAt(app.db, appId, FORGE_JSON)).toMatchObject({
      FORGE_FEATURE: "1",
      FORGE_SETTING_RUN_DAYS: "mon,wed,fri",
      FORGE_SETTING_RUN_HOUR_UTC: "9",
      FORGE_SETTING_SCOUT: "true",
    });
    const changed = listEvents(app.db, { repoId: repo.id }).filter((e) => e.kind === "app.feature_settings");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload["keys"]).toEqual(["runDays", "runHourUtc"]);
    // The page's form: days from checkboxes, an unchecked bool off.
    const form = new URLSearchParams([
      ["s.runDays", ""],
      ["s.runDays", "tue"],
      ["s.runHourUtc", "9"],
      ["s.claudeCode", "stable"],
      ["s.scout", "off"],
    ]);
    const saved = await web(adaCookie, "/settings/features/radar", form);
    expect(saved.status).toBe(303);
    expect(featureVarsAt(app.db, appId, FORGE_JSON)).toMatchObject({
      FORGE_SETTING_RUN_DAYS: "tue",
      FORGE_SETTING_CLAUDE_CODE: "stable",
      FORGE_SETTING_SCOUT: "false",
    });
    const page = await (await web(adaCookie, "/settings/features/radar")).text();
    expect(page).toContain("FORGE_SETTING_RUN_DAYS");
  });

  test("un-absorbing puts it back as an ordinary app and keeps its values for the next absorb", async () => {
    const out = await unabsorbApp(app, ada, "radar");
    expect(out.ok && out.value.absorbed).toBe(false);
    expect(featureVarsAt(app.db, appId, FORGE_JSON)).toEqual({});
    expect(absorbedForNav(app, ada)).toEqual([]);
    expect((await api("DELETE", adaToken, "/radar")).status).toBe(409);
    const changeWhileOut = await changeFeatureSettings(app, ada, "radar", { runHourUtc: 1 });
    expect(!changeWhileOut.ok && changeWhileOut.error.error).toBe("not_absorbed");
    await absorbApp(app, ada, "radar");
    expect(featureVarsAt(app.db, appId, FORGE_JSON)).toMatchObject({ FORGE_SETTING_RUN_DAYS: "tue", FORGE_SETTING_RUN_HOUR_UTC: "9" });
  });

  test("the MCP tool plans first, and applies only with an admin-scope token", async () => {
    const plan = await mcpTool(servers.url, adaToken, "features", { slug: "radar", settings: { runHourUtc: 14 } });
    expect(plan.value?.says).toContain("Would set runHourUtc");
    expect(featureSettings(app.db, appId).get("runHourUtc")).toBe("9");
    const readOnly = await mcpTool(servers.url, adaReadToken, "features", { slug: "radar", settings: { runHourUtc: 14 }, dryRun: false });
    expect(readOnly.error).toBeDefined();
    const done = await mcpTool(servers.url, adaToken, "features", { slug: "radar", settings: { runHourUtc: 14 }, dryRun: false });
    expect(done.value?.absorbed).toBe(true);
    expect(featureSettings(app.db, appId).get("runHourUtc")).toBe("14");
    const stranger = await mcpTool(servers.url, bobToken, "features", { slug: "radar" });
    expect(stranger.error).toBeDefined();
  });

  test("the declaration is cached by tip: the same tip is one read, a moved tip reads again", async () => {
    const first = await declaredFeature(app, repo);
    expect(await declaredFeature(app, repo)).toBe(first); // the very same parsed result
    const moved = JSON.stringify({ app: { run: "bun run src/server.ts" }, feature: { ...FEATURE, name: "Radar 2" } });
    const done = await commitToBranch(app, cy, repo, { message: "rename", files: [{ path: "forge.json", content: moved }] });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const after = await declaredFeature(app, repo);
    expect(after).not.toBe(first);
    expect(after.ok && after.value?.name).toBe("Radar 2");
  });

  test("with 20 more absorbed apps the menu is built from one pass and renders within budget", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await createRepo(app, cy, { name: `many-${i}`, visibility: "public", description: "" });
      if (!r.ok) throw new Error(String(r.error));
      const row = insertApp(app.db, { repoId: r.value.id, slug: `many-${i}`, access: "public" });
      if (!row.ok) throw new Error(row.error);
      absorb(app.db, row.value.id, ada.id, `Many ${i}`, "/");
    }
    let nav = absorbedForNav(app, ada);
    expect(nav.length).toBeGreaterThanOrEqual(20);
    expect(nav.every((f) => f.record.id === f.appId)).toBe(true); // the record rides along
    const n = nav.length;
    const used = await statements(app.db, async () => {
      nav = absorbedForNav(app, ada);
    });
    expectWork(used, { max: 2 + 3 * n }); // one list, then at most three reads per absorbed app
    const page = await (await web(adaCookie, "/settings")).text();
    expect(page).toContain("Many 19");
  });

  test("deleting the app takes its feature row and settings with it", () => {
    const rows = (table: string) =>
      app.db.query(`SELECT 1 FROM ${table} WHERE app_id = ?1`).all(appId).length;
    expect(rows("app_feature")).toBe(1);
    expect(rows("app_feature_setting")).toBeGreaterThan(0);
    expect(deleteApp(app.db, appId)).toBe(true);
    expect(rows("app_feature")).toBe(0);
    expect(rows("app_feature_setting")).toBe(0);
  });
});
